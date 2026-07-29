import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// 👉 นำเข้าโมดูลระบบภายในเกมทั้งหมด
import { processCardAbilities } from './abilityEngine.js';
import { declareAttack, resolveCombat } from './battleEngine.js';
import { playMagicCard } from './magicEngine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(express.static(__dirname));

let rooms = {};
let activeRooms = {}; 

function loadCardsDatabase() {
    try {
        if (fs.existsSync('cards.json')) {
            const data = fs.readFileSync('cards.json', 'utf-8');
            return JSON.parse(data);
        }
    } catch (e) {
        console.error("> โหลดไฟล์ cards.json ไม่สำเร็จ:", e.message);
    }
    return [];
}

io.on('connection', (socket) => {
    console.log(`> ผู้เล่นเชื่อมต่อสำเร็จ: ${socket.id}`);

    socket.emit('update-room-list', activeRooms);

    socket.on('get-rooms', () => {
        socket.emit('update-room-list', activeRooms);
    });

    socket.on('create-room', (roomName) => {
        if (!rooms[roomName]) {
            rooms[roomName] = {
                id: roomName,
                turnCount: 1,
                turnHistory: [],
                magicUsage: {},
                turnUsage: {},
                players: {
                    player1: { id: socket.id, hand: [], deck: [], board: { avatarZone: [], magicZone: [], hellZone: [] }, lifeZone: [] },
                    player2: null
                }
            };
            activeRooms[roomName] = { name: roomName, playersCount: 1 };
            socket.join(roomName);
            socket.emit('room-created', roomName);
            io.emit('update-room-list', activeRooms);
        } else {
            socket.emit('error-message', 'ชื่อห้องนี้ถูกใช้งานแล้ว');
        }
    });

    socket.on('join-room', (roomName) => {
        let game = rooms[roomName];
        if (game && !game.players.player2) {
            game.players.player2 = { id: socket.id, hand: [], deck: [], board: { avatarZone: [], magicZone: [], hellZone: [] }, lifeZone: [] };
            activeRooms[roomName].playersCount = 2;
            socket.join(roomName);
            socket.emit('room-joined', roomName);
            io.to(roomName).emit('game-start', game);
            io.emit('update-room-list', activeRooms);
        } else {
            socket.emit('error-message', 'ห้องเต็มหรือไม่มีห้องนี้อยู่');
        }
    });

    // -------------------------------------------------------------------------
    // 1. ระบบจัดการการอัญเชิญ Avatar และเรียกใช้ Ability Engine
    // -------------------------------------------------------------------------
    socket.on('summon-avatar', ({ roomName, playerRole, cardId }) => {
        let game = rooms[roomName];
        if (!game) return;

        let pState = game.players[playerRole];
        let cardIndex = pState.hand.findIndex(c => c.id === cardId);

        if (cardIndex !== -1) {
            let card = pState.hand.splice(cardIndex, 1)[0];
            pState.board.avatarZone.push(card);

            console.log(`🎴 [Server] ผู้เล่น ${playerRole} อัญเชิญการ์ด [${card.name}] ลง Avatar Zone`);

            // ประมวลผลความสามารถตอนจุติ (On Summon) ผ่าน Ability Engine
            processCardAbilities(game, playerRole, card, 'ON_SUMMON');

            io.to(roomName).emit('game-state-update', game);
        }
    });

    // -------------------------------------------------------------------------
    // 2. ระบบจัดการการใช้การ์ดเวทมนตร์ (Magic Card) ผ่าน Magic Engine
    // -------------------------------------------------------------------------
    socket.on('play-magic', ({ roomName, playerRole, cardId, targetAvatarId }) => {
        let game = rooms[roomName];
        if (!game) return;

        let pState = game.players[playerRole];
        let cardIndex = pState.hand.findIndex(c => c.id === cardId);

        if (cardIndex === -1) {
            socket.emit('error-message', 'ไม่พบการ์ดเวทมนตร์นี้ในมือ');
            return;
        }

        let magicCard = pState.hand[cardIndex];
        let targetAvatar = null;
        if (targetAvatarId) {
            targetAvatar = pState.board.avatarZone.find(a => a.id === targetAvatarId);
        }

        // เรียกใช้งาน Magic ผ่าน Magic Engine (ตรวจสอบกฎประเภทละ 1 ครั้งต่อเทิร์น)
        let success = playMagicCard(game, playerRole, magicCard, targetAvatar);

        if (success) {
            pState.hand.splice(cardIndex, 1); // นำออกจากมือเมื่อใช้สำเร็จ
            io.to(roomName).emit('game-state-update', game);
            console.log(`✨ [Server] ผู้เล่น ${playerRole} ใช้เวทมนตร์ [${magicCard.name}] สำเร็จ`);
        } else {
            socket.emit('error-message', `ไม่สามารถใช้เวทมนตร์ [${magicCard.name}] ได้ตามกฎของเกม`);
        }
    });

    // -------------------------------------------------------------------------
    // 3. ระบบการต่อสู้และการโจมตีผู้เล่นโดยตรง (Battle Engine)
    // -------------------------------------------------------------------------
    socket.on('declare-attack', ({ roomName, attackerRole, attackerId, targetType, targetId }) => {
        let game = rooms[roomName];
        if (!game) return;

        console.log(`⚔️ [Server] ผู้เล่น ${attackerRole} สั่งโจมตี Target: ${targetType}`);

        // เรียกใช้งานฟังก์ชันจาก Battle Engine (รองรับทั้งตี Avatar และ Direct Attack ใส่ผู้เล่น)
        let success = declareAttack(game, attackerRole, attackerId, targetType, targetId);

        if (success) {
            io.to(roomName).emit('game-state-update', game);
        } else {
            socket.emit('error-message', 'คำสั่งโจมตีไม่ถูกต้องตามกติกา');
        }
    });

    socket.on('disconnect', () => {
        console.log(`> ผู้เล่นตัดการเชื่อมต่อ: ${socket.id}`);
        setTimeout(() => {
            for (let roomName in activeRooms) {
                const roomClients = io.sockets.adapter.rooms.get(roomName);
                const roomSize = roomClients ? roomClients.size : 0;
                if (roomSize === 0) {
                    delete activeRooms[roomName];
                    delete rooms[roomName];
                } else {
                    activeRooms[roomName].playersCount = roomSize;
                }
            }
            io.emit('update-room-list', activeRooms);
        }, 500);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server กำลังรันอยู่ที่พอร์ต http://localhost:${PORT}`);
});