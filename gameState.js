// ==========================================
// ศูนย์กลางสถานะเกมหลัก (Game State & Orchestrator)
// ==========================================
import fs from 'fs';
import { checkZoneLimits, checkConstructDuplicate } from './rulesEngine.js';
import { calculateNetPower, resolveCombat } from './battleEngine.js';

// โหลดฐานข้อมูลการ์ด
const rawData = fs.readFileSync('./cards.json');
const cardDatabase = JSON.parse(rawData);

// จำลองสถานะเกมรวมของทั้งสองผู้เล่น
const gameState = {
    turnCount: 1,
    activePlayer: "playerA",
    currentPhase: "Main",
    players: {
        playerA: {
            hand: [
                { id: "A001", name: "พระนารายณ์", type: "Avatar", cost: 2, gem: 2, basePower: 4, modifiers: [] },
                { id: "C001", name: "ป้อมปืนเลเซอร์", type: "Construct", cost: 0, gem: 1, basePower: 0 }
            ],
            board: { avatarZone: [], constructZone: [], hellZone: [] }
        },
        playerB: {
            hand: [],
            board: { 
                avatarZone: [
                    { id: "B002", name: "กุ่ย", type: "Avatar", cost: 1, gem: 1, basePower: 2, modifiers: [] }
                ], 
                constructZone: [], 
                hellZone: [] 
            }
        }
    }
};

// ฟังก์ชันควบคุมการลงการ์ด Avatar
function playAvatar(player, cardId) {
    let pState = gameState.players[player];
    let idx = pState.hand.findIndex(c => c.id === cardId);
    if (idx === -1) return console.log("❌ ไม่พบการ์ดบนมือ");
    
    let card = pState.hand[idx];
    if (checkZoneLimits(pState, card.isToken || false)) {
        pState.board.avatarZone.push(pState.hand.splice(idx, 1)[0]);
        console.log(`✅ [${player}] อัญเชิญ Avatar [${card.name}] ลงสนามสำเร็จ!`);
    }
}

// ==========================================
// รันทดสอบระบบครบวงจร (Integration Test)
// ==========================================
console.log("=== เริ่มจำลองการทำงานระบบเซิร์ฟเวอร์การ์ดเกม (Modular) ===");

// 1. playerA ลงการ์ด "พระนารายณ์" ลงสนาม
playAvatar("playerA", "A001");

// 2. ตรวจสอบค่าพลังสุทธิของพระนารายณ์บนสนามโดยเรียกจาก Battle Engine
let narayana = gameState.players["playerA"].board.avatarZone[0];
console.log(`> ค่าพลังสุทธิของ [${narayana.name}]: ${calculateNetPower(narayana, gameState)}`);

// 3. สั่งให้ พระนารายณ์ (playerA) โจมตีและตัดสินผลกับ กุ่ย (playerB)
resolveCombat(gameState, "playerA", "A001", "playerB", "B002");

// 4. สรุปสถานะหลังการต่อสู้
console.log("\n=== สรุปสถานะหลังการต่อสู้จบ ===");
console.log("playerA Avatar บนสนาม:", gameState.players["playerA"].board.avatarZone.map(c => c.name));
console.log("playerB ในนรก (Hell Zone):", gameState.players["playerB"].board.hellZone.map(c => c.name));