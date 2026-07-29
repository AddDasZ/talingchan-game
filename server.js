import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// 👉 นำเข้าโมดูลระบบภายในเกมทั้งหมด
import { processCardAbilities } from './abilityEngine.js';
import { declareAttack, resolveCombat } from './battleEngine.js';
import { playMagicCard, resolvePendingMagic, extractChoiceOptions } from './magicEngine.js';
import { handleScoutAbility } from './abilityEngine.js';

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

// 🛑 โหลดฐานข้อมูลการ์ดทั้งหมดจาก cards.json ไว้ใช้งานกลาง
let cardDatabase = [];
try {
    const data = fs.readFileSync(path.join(__dirname, 'cards.json'), 'utf8');
    cardDatabase = JSON.parse(data);
    console.log(`📦 โหลดข้อมูลการ์ดสำเร็จทั้งหมด ${cardDatabase.length} ใบ`);
} catch (err) {
    console.error("❌ ไม่สามารถโหลดไฟล์ cards.json ได้:", err);
}

// 🛑 2. สร้างฟังก์ชันช่วยดึงค่า gem และข้อมูลจริงจากฐานข้อมูล
function enrichCardData(cardInput) {
    if (!cardInput) return null;
    let found = cardDatabase.find(c => c.id === cardInput.id && c.name === cardInput.name) ||
                cardDatabase.find(c => c.id === cardInput.id) ||
                cardDatabase.find(c => c.name === cardInput.name);

    if (found) {
        // 🌟 [แก้บั๊กตรงนี้] ดึงข้อมูลทั้งหมดจากฐานข้อมูล (...found) มาทับ
        // เพื่อให้ได้ค่า reactCondition, magicSubtype และ structuredAbilities ครบถ้วน
        return {
            ...cardInput,
            ...found, 
            gem: found.gem !== undefined ? Number(found.gem) : (cardInput.gem || 0),
            cost: found.cost !== undefined ? Number(found.cost) : (cardInput.cost || 0),
            basePower: found.basePower !== undefined ? Number(found.basePower) : (cardInput.basePower || 0),
            uniqueId: cardInput.uniqueId // รักษา ID เฉพาะตัวไว้
        };
    }
    
    return {
        ...cardInput,
        gem: cardInput.gem !== undefined ? Number(cardInput.gem) : 0
    };
}

// 🔗 ฟังก์ชันกลางสำหรับอ่านชื่อ "คู่หู" จาก Text ของการ์ดอย่างแม่นยำ
function getPartnerName(text) {
    if (!text) return null;
    
    // กวาดข้อความหลังคำว่า "คู่หู" หรือ "Link" จนกว่าจะไปชนคีย์เวิร์ดสกิลหลักตัวต่อไป หรือจบข้อความ
    let match = text.match(/(?:คู่หู|link)\s*[-:\[\]"']*\s*(.+?)(?:["']|\s+(?:อัตโนมัติ|สั่งใช้|ต่อเนื่อง|จุติ|คำสั่งเสีย|เทิร์นละครั้ง|พอดี|แทงหลัง|สามัคคี|โล่มนุษย์)|$)/i);
    
    if (match && match[1]) {
        return match[1].trim(); // คืนค่าชื่อคู่หูแบบสะอาดๆ (เช่น "จอมเวทย์ โกลเด้น" หรือ "เพมมุ")
    }
    return null;
}

// 📢 ระบบทำงานอัตโนมัติตามเฟส (Phase Trigger Engine)
function executePhaseTriggers(game, roomName, phaseName) {
    ['playerA', 'playerB'].forEach(role => {
        let pState = game.players[role];
        if (!pState || !pState.board || !pState.board.avatarZone) return;

        pState.board.avatarZone.forEach(card => {
            let text = getEffectiveAbilityText(pState, card).toLowerCase();

            // --- 🌙 เช็คช่วง END PHASE ---
            if (phaseName === 'END_PHASE') {   
                if (text.includes('ในช่วง end phase') || text.includes('ใน end phase')) {
            
                    // เงื่อนไข: ถ้าเป็น "End Phase ของเรา"
                    if (text.includes('ของเรา') && role !== game.activePlayer) return;

                    // 🐶 เคส: สไปรท์ ยอดสุนัข (ปลุกตื่น และ/หรือ บัฟพลังจนถึง Draw Phase ถัดไป)
                    // 🌟 [แก้ไขตรงนี้] ใช้ Regex /เปลี่ยนเป็น\s*สภาพตื่น/i เพื่อรองรับกรณีมีช่องว่างระหว่างคำ
                    if (/เปลี่ยนเป็น\s*สภาพตื่น/i.test(text) && card.isResting) {
                        card.isResting = false;
                        addGameLog(game, `🔆 [Phase Trigger] [${card.name}] เปลี่ยนเป็นสภาพตื่นใน End Phase!`);
                    }
            
                    let powerMatch = text.match(/power\s*\+\s*(\d+)\s*จนถึง\s*draw phase/);
                    if (powerMatch) {
                        let amt = parseInt(powerMatch[1]);
                        if (!card.tempEffects) card.tempEffects = [];
                        // เซ็ตให้บัฟอยู่รอดข้ามเทิร์นฝ่ายตรงข้าม ไปหมดอายุตอน Draw Phase เรา
                        card.tempEffects.push({ amount: amt, expireAt: 'DRAW_PHASE_SELF' });
                        addGameLog(game, `✨ [Phase Trigger] [${card.name}] POWER +${amt} จนถึง Draw Phase ถัดไป!`);
                    }
                }
            }

            // --- ⚔️ เช็คช่วง BATTLE PHASE ---
            if (phaseName === 'BATTLE_PHASE') {
                if (text.includes('ใน battle phase') || text.includes('เมื่อเข้าสู่ battle phase')) {
                    
                    // การแจก Keyword พิเศษ (เช่น "ได้รับ ลูกฮึด")
                    let keywordsToScan = ['โล่มนุษย์', 'ลูกฮึด', 'เตะไข่', 'แทงหลัง', 'สามัคคี'];
                    keywordsToScan.forEach(kw => {
                        if (text.includes(`ได้รับ ${kw}`) || text.includes(`ได้รับ '${kw}'`)) {
                            if (!card.tempTraits) card.tempTraits = [];
                            // แปะ Keyword ให้ แล้วตั้งเวลาให้หมดฤทธิ์ตอนเข้า End Phase
                            card.tempTraits.push({ trait: kw, expireAt: 'END_PHASE' });
                            addGameLog(game, `🛡️ [Phase Trigger] [${card.name}] ได้รับ ${kw} ในเฟสนี้!`);
                        }
                    });
                }
            }
        });
    });
    
    // คำนวณพลังใหม่ทันทีหลังแจกบัฟเสร็จ
    updateAllBoardPower(game);
}

// 🔗 ฟังก์ชันกรองความสามารถ: ตัดความสามารถที่ถูกล็อกด้วย "คู่หู/Link" ออก หากไม่มีคู่หูบนสนาม
// 🔗 ฟังก์ชันกรองความสามารถ: (อัปเดตใหม่ ไม่ตัด Text หลักทิ้งแล้ว)
function getEffectiveAbilityText(playerState, avatarCard) {
    let text = avatarCard.abilityText || "";
    
    // แปะ Keyword ชั่วคราวเข้าไปใน Text เพื่อให้ระบบ Combat อ่านเจอ
    if (avatarCard.tempTraits && avatarCard.tempTraits.length > 0) {
        let activeTraits = avatarCard.tempTraits.map(t => t.trait).join(" ");
        text += " " + activeTraits;
    }

    return text;
}

// 🧮 ระบบคำนวณพลัง (Power Calculation Engine & Effect Layers)
function calculateAvatarPower(game, ownerRole, avatar) {
    if (!avatar) return 0;
    
    let pState = game.players[ownerRole];
    let oppRole = ownerRole === 'playerA' ? 'playerB' : 'playerA';
    let oppState = game.players[oppRole];

    // 🔷 Layer 0: ค่าพลังตั้งต้น
    let basePower = Number(avatar.basePower) || 0;

    // 🔷 Layer 1: บัฟโดยตรงจาก Modification Magic
    let equipBonus = 0;
    if (avatar.equippedCards && avatar.equippedCards.length > 0) {
        avatar.equippedCards.forEach(mod => {
            let modText = (mod.abilityText || "").toLowerCase();
            let plusMatch = modText.match(/power\s*\+\s*(\d+)/);
            if (plusMatch) equipBonus += parseInt(plusMatch[1]);
            
            let minusMatch = modText.match(/power\s*-\s*(\d+)/);
            if (minusMatch) equipBonus -= parseInt(minusMatch[1]);
        });
    }

    // 🌟 Layer 1.5: ความสามารถต่อเนื่องแบบบัฟตัวเอง (Self-Continuous)
    let selfContinuousBonus = 0;
    let selfText = getEffectiveAbilityText(pState, avatar).toLowerCase();
    
    if (selfText.includes('ต่อเนื่อง')) {
        
        // 🦍 1. แพทเทิร์น หนุมาน: "เพิ่ม power ตามจำนวน avatar {เผ่า} บนสนามฝ่ายเรา ใบละ X"
        if (selfText.includes('เพิ่ม power ตามจำนวน avatar')) {
            let symbolMatch = selfText.match(/\{([^}]+)\}/); // หาคำในปีกกา เช่น {เทพ}
            let multiplierMatch = selfText.match(/ใบละ\s*(\d+)/); // หาตัวคูณ
            let multi = multiplierMatch ? parseInt(multiplierMatch[1]) : 1;

            if (symbolMatch) {
                let targetSymbol = symbolMatch[1].trim();
                // นับจำนวนการ์ดบนสนามเราที่มี Symbol ตรงกัน (นับตัวเองด้วยถ้าเผ่าตรง)
                let count = pState.board.avatarZone.filter(a => (a.symbol || "").toLowerCase().includes(targetSymbol)).length;
                selfContinuousBonus += (count * multi);
            }
        }

        // 🌳 2. แพทเทิร์น มาโกะ: "power +X ตามจำนวน [ชื่อการ์ด] บน magic zone"
        let makoMatch = selfText.match(/power\s*\+\s*(\d+)\s*ตามจำนวน\s*(.+?)\s*บน\s*magic zone/);
        if (makoMatch) {
            let buffAmt = parseInt(makoMatch[1]);
            let targetName = makoMatch[2].trim(); // ได้คำว่า "ต้นมะม่วง"
            // นับจำนวนการ์ดใน Magic Zone ที่ชื่อมีคำว่า ต้นมะม่วง
            let count = pState.board.magicZone.filter(m => m.name.toLowerCase().includes(targetName)).length;
            selfContinuousBonus += (count * buffAmt);
        }

        // 👻 3. แพทเทิร์น ปื้ด: "เพิ่ม power ตามจำนวน life card ที่หงาย"
        if (selfText.includes('เพิ่ม power ตามจำนวน life card') && selfText.includes('หงาย')) {
            let multiplierMatch = selfText.match(/ใบละ\s*(\d+)/);
            let multi = multiplierMatch ? parseInt(multiplierMatch[1]) : 2; // ของปื้ดคือใบละ 2
            let count = pState.lifeZone.filter(l => l.isRevealed).length;
            selfContinuousBonus += (count * multi);
        }
    }

    // 🌟 Layer 2: ความสามารถต่อเนื่องแบบออร่า (Aura Continuous) & Land Magic
    let auraBonus = 0;

    // 2A: เช็คเพื่อนบนบอร์ดว่ามีใครส่ง "ออร่า" มาบัฟให้เราไหม? (เช่น เผ่าเดียวกันได้บวกพลัง)
    pState.board.avatarZone.forEach(friend => {
        if (friend.uniqueId === avatar.uniqueId) return; // ไม่นับตัวเอง (ออร่าส่วนใหญ่บัฟคนอื่น)
        let friendText = getEffectiveAbilityText(pState, friend).toLowerCase();
        
        if (friendText.includes('ต่อเนื่อง')) {
            // ค้นหาข้อความแนวๆ "avatar {กะปอม} ทุกใบบน avatar zone ฝ่ายเรา power +1"
            let auraMatch = friendText.match(/avatar\s*\{([^}]+)\}.*?power\s*\+\s*(\d+)/);
            if (auraMatch) {
                let targetSymbol = auraMatch[1].trim();
                let buffAmt = parseInt(auraMatch[2]);
                // ถ้าสัญลักษณ์ของเราตรงกับที่ออร่าแจก ก็รับบัฟไปเลย
                if ((avatar.symbol || "").toLowerCase().includes(targetSymbol)) {
                    auraBonus += buffAmt;
                }
            }
        }
    });

    // 2B: Land Magic (อิงจากโค้ดเดิมของคุณ)
    if (game.landMagicZone && game.landMagicZone.card) {
        let landText = (game.landMagicZone.card.abilityText || "").toLowerCase();
        let avatarSymbol = (avatar.symbol || "").toLowerCase();
        let hasSymbolCondition = landText.match(/\{[^}]+\}/) !== null || landText.includes('เผ่า');
        let isSymbolMatched = avatarSymbol !== "" && (landText.includes(`{${avatarSymbol}}`) || landText.includes(`เผ่า${avatarSymbol}`) || landText.includes(avatarSymbol));

        let plusMatch = landText.match(/power\s*\+\s*(\d+)/i);
        if (plusMatch && (isSymbolMatched || (!hasSymbolCondition && landText.includes('ทุกใบ')))) {
            auraBonus += parseInt(plusMatch[1]);
        }
        let minusMatch = landText.match(/power\s*-\s*(\d+)/i);
        if (minusMatch && (isSymbolMatched || (!hasSymbolCondition && landText.includes('ทุกใบ')))) {
            auraBonus -= parseInt(minusMatch[1]);
        }
    }

    // 🔷 Layer 3: Snapshot Power (พลังสุทธิก่อนเข้าสู้)
    let snapshotPower = basePower + equipBonus + selfContinuousBonus + auraBonus;
    avatar.snapshotPower = snapshotPower; 

    // 👉 🔷 Layer 4: บัฟชั่วคราวจาก Effect Manager (เช่น จนถึง End Phase / จบเทิร์น)
    let layer4Bonus = 0;
    if (avatar.tempEffects && avatar.tempEffects.length > 0) {
        avatar.tempEffects.forEach(effect => {
            layer4Bonus += effect.amount;
        });
    }

    // 🔷 Layer 5: บัฟฉุกเฉินตอนต่อสู้แบบเก่า (React Magic / Combat Buff)
    let layer5Bonus = avatar.tempCombatPower || 0; 

    // สรุปผลรวม
    let finalPower = snapshotPower + layer4Bonus + layer5Bonus;
    return finalPower < 0 ? 0 : finalPower; // พลังติดลบไม่ได้
}

// 🌍 ระบบประมวลผลสถานะต่อเนื่องและออร่าสนาม (Continuous State & Aura Engine)
function updateContinuousStates(game) {
    ['playerA', 'playerB'].forEach(role => {
        let pState = game.players[role];
        let oppRole = role === 'playerA' ? 'playerB' : 'playerA';
        let oppState = game.players[oppRole];

        if (!pState || !pState.board || !pState.board.avatarZone) return;

        // 1. รีเซ็ตสถานะชั่วคราวทิ้งก่อนคำนวณใหม่ทุกรอบ
        pState.board.avatarZone.forEach(avatar => {
            avatar.forcedSymbol = null; // Symbol ที่ถูกบังคับเปลี่ยน
            avatar.overriddenName = null; // ชื่อที่ถูกเปลี่ยน
            avatar.isAttackTargetForced = false; // โดนบังคับให้เป็นเป้าหมายโจมตีเดี่ยวๆ ไหม (Taunt)
        });
    });

    // 2. กวาดหาการ์ดที่มีผลต่อเนื่อง (Continuous Aura) จากทั้งสองฝั่ง และ Land Magic
    ['playerA', 'playerB'].forEach(role => {
        let pState = game.players[role];
        let oppRole = role === 'playerA' ? 'playerB' : 'playerA';
        let oppState = game.players[oppRole];

        let allBoardCards = [
            ...(pState.board.avatarZone || []),
            ...(pState.board.constructZone || [])
        ];

        // เช็ค Land Magic ตรงกลางสนามด้วย
        if (game.landMagicZone && game.landMagicZone.card) {
            allBoardCards.push(game.landMagicZone.card);
        }

        allBoardCards.forEach(sourceCard => {
            let text = (sourceCard.abilityText || "").toLowerCase();
            if (!text.includes('ต่อเนื่อง')) return;

            // 🏛️ เคส A: Land Magic "แอสการ์ดคือสถานที่ไม่ใช่ผู้คน" (เปลี่ยน Symbol ทุกใบเป็น เทพ)
            if (sourceCard.name.includes('แอสการ์ดคือสถานที่ไม่ใช่ผู้คน') || text.includes('เปลี่ยน symbol ของ avatar ทุกใบบน avatar zone เป็น symbol {เทพ}')) {
                // มีผลกับสนามของทุกคนตาม Rulebook
                ['playerA', 'playerB'].forEach(targetRole => {
                    game.players[targetRole].board.avatarZone.forEach(av => {
                        av.forcedSymbol = 'เทพ';
                    });
                });
            }

            // 🛡️ เคส B: ล็อกเป้าหมายโจมตี (เช่น จอมเวทย์ เดสสึหวา หรือ เตียวคับ)
            // "ผู้เล่นฝ่ายตรงข้าม ไม่สามารถเลือกเป้าหมายโจมตีได้ นอกจากการ์ดใบนี้"
            if (text.includes('ไม่สามารถเลือกเป้าหมายโจมตีได้ นอกจากการ์ดใบนี้') || text.includes('ไม่สามารถเลือกเป้าหมายการโจมตี ไปที่ avatar') && text.includes('ยกเว้น')) {
                // บังคับให้การ์ดใบนี้มีสถานะ Taunt (ศัตรูต้องตีตัวนี้เท่านั้น)
                sourceCard.isAttackTargetForced = true;
            }

            // 👑 เคส C: ราชาสิ่งปฏิกูล (เปลี่ยนชื่อและ Symbol ของการ์ดเป้าหมาย)[cite: 5]
            if (sourceCard.name.includes('ราชาสิ่งปฏิกูล') && text.includes('เปลี่ยนชื่อของ avatar ใบนั้นเป็น "สิ่งปฏิกูล"')) {
                // (สามารถเชื่อมกับระบบ Target เลือกเป้าหมายตอนจุติได้ในอนาคต)
            }
        });
    });
}

// ฟังก์ชันอัปเดตพลังของ Avatar ทั้งสนามแบบ Real-time
function updateAllBoardPower(game) {
    updateContinuousStates(game);
    ['playerA', 'playerB'].forEach(role => {
        let pState = game.players[role];
        if (pState && pState.board && pState.board.avatarZone) {
            pState.board.avatarZone.forEach(avatar => {
                // 1. คำนวณพลังตามปกติ
                avatar.currentPower = calculateAvatarPower(game, role, avatar);

                // 🔗 2. [อัปเดต] ระบบคู่หู (ตรวจสอบการหลุดลิงก์เท่านั้น ไม่จับคู่อัตโนมัติ)
                let partnerName = getPartnerName(avatar.abilityText);
                avatar.partnerNameStr = partnerName; // ฝังชื่อคู่หูไปให้หน้าเว็บเสมอ

                if (partnerName && avatar.isLinkedStatus) {
                    // ถ้าเคยลิงก์ไว้แล้ว ให้เช็คว่าคู่หูยังอยู่บนสนามไหม?
                    let hasPartner = pState.board.avatarZone.some(a => 
                        a.uniqueId !== avatar.uniqueId && a.name.includes(partnerName)
                    );
                    
                    if (!hasPartner) {
                        addGameLog(game, `💔 [${avatar.name}] สูญเสียสถานะคู่หู เพราะคู่หูหายไปจากสนาม...`);
                        avatar.isLinkedStatus = false; // ปลดสถานะออก
                    }
                }

                // 📝 3. เทียบสถานะเก่ากับปัจจุบัน เพื่อเด้งแจ้งเตือนใน Action Log
                if (currentLinked && !avatar.isLinkedStatus) {
                    // เพิ่งเข้าสู่สถานะคู่หู
                    addGameLog(game, `🔗 [${avatar.name}] เข้าสู่สถานะคู่หูกับ [${partnerName}] แล้ว!`);
                    avatar.isLinkedStatus = true; // บันทึกลงตัวการ์ดว่าลิงก์แล้ว
                } else if (!currentLinked && avatar.isLinkedStatus) {
                    // คู่หูหายไปจากบอร์ด (ตาย/ขึ้นมือ)
                    addGameLog(game, `💔 [${avatar.name}] สูญเสียสถานะคู่หู...`);
                    avatar.isLinkedStatus = false; // ปลดสถานะออก
                }
            });
        }
    });
}

// ⏳ ระบบจัดการบัฟ/ดีบัฟชั่วคราว: ล้างเอฟเฟกต์เมื่อถึงเวลาที่กำหนด
function clearTemporaryEffects(game, expireEvent, currentActivePlayer = null) {
    let hasCleared = false;
    ['playerA', 'playerB'].forEach(role => {
        let pState = game.players[role];
        if (pState && pState.board && pState.board.avatarZone) {
            pState.board.avatarZone.forEach(avatar => {
                
                // 1. เคลียร์ Power Buff (ตัวเลข)
                if (avatar.tempEffects) {
                    let originalLength = avatar.tempEffects.length;
                    avatar.tempEffects = avatar.tempEffects.filter(eff => {
                        // เคสพิเศษ: หมดอายุตอน Draw Phase ของตัวเอง (เช่น สไปรท์)
                        if (eff.expireAt === 'DRAW_PHASE_SELF' && expireEvent === 'DRAW_PHASE') {
                            return role !== currentActivePlayer; // ถ้าถึงตาเจ้าของการ์ดแล้ว ให้ลบทิ้ง
                        }
                        return eff.expireAt !== expireEvent;
                    });
                    if (avatar.tempEffects.length < originalLength) hasCleared = true;
                }

                // 2. เคลียร์ Keyword Buff (ความสามารถ)
                if (avatar.tempTraits) {
                    let originalLength = avatar.tempTraits.length;
                    avatar.tempTraits = avatar.tempTraits.filter(eff => eff.expireAt !== expireEvent);
                    if (avatar.tempTraits.length < originalLength) hasCleared = true;
                }
            });
        }
    });
    
    if (hasCleared) {
        console.log(`⏳ เคลียร์บัฟที่หมดอายุในเฟส [${expireEvent}] เรียบร้อย`);
        updateAllBoardPower(game);
    }
}

// 📦 ฟังก์ชันตัวกลางสำหรับส่ง Game State ไปให้ Client
function broadcastGameState(roomName, game) {
    updateAllBoardPower(game); // คำนวณพลังก่อนเสมอ
    io.to(roomName).emit('game-state-update', game); // ส่งข้อมูลให้ Client
    
    // 👇 เพิ่มบรรทัดนี้ เพื่อให้ระบบเช็คเงื่อนไขเด็คหมด ทุกครั้งที่มีความเคลื่อนไหว
    checkWinConditions(game, roomName); 
}

// 📝 ฟังก์ชันระบบบันทึก Action Log
function addGameLog(game, message) {
    if (!game.actionLog) game.actionLog = [];
    
    // ดึงเวลาปัจจุบัน (เช่น 14:30:15)
    let time = new Date().toLocaleTimeString('th-TH', { hour12: false, hour: '2-digit', minute:'2-digit', second:'2-digit' });
    game.actionLog.push(`[${time}] ${message}`);
    
    // ป้องกัน Array ใหญ่เกินไป ให้เก็บแค่อดีต 50 บรรทัดล่าสุดพอ
    if (game.actionLog.length > 50) {
        game.actionLog.shift(); 
    }
}

// 🧠 ระบบบันทึกเหตุการณ์ที่เกิดขึ้นในเทิร์นนี้ (Event History Logger)
function logTurnEvent(game, eventType, details = {}) {
    if (!game.turnHistory) game.turnHistory = [];
    
    game.turnHistory.push({
        type: eventType,         // เช่น 'COMBAT_DESTROY', 'PLAY_MAGIC', 'MILL_DECK'
        timestamp: Date.now(),
        ...details               // ข้อมูลเพิ่มเติม เช่น { playerRole: 'playerA', cardName: 'พระนารายณ์' }
    });
}

// 📥 ฟังก์ชันจับ Effect ใส่เข้า Stack
function queueEffect(game, roomName, playerRole, card, triggerType, contextData = {}) {
    // โยน Effect เข้าไปต่อท้ายคิว
    game.effectStack.push({ 
        playerRole: playerRole, 
        card: card, 
        triggerType: triggerType, 
        contextData: contextData 
    });
    
    console.log(`📥 [Stack] เพิ่ม [${card.name}] (${triggerType}) ลงใน Stack (จำนวนปัจจุบัน: ${game.effectStack.length})`);

    // ถ้าระบบไม่ได้กำลังเคลียร์ Stack อยู่ และไม่ได้ค้างหน้าต่างรอใคร ให้เริ่มเคลียร์ Stack ทันที
    if (!game.isResolvingStack && !game.pendingTargetAction && !game.reactionWaitingFor && !game.pendingScoutData) {
        resolveNextEffect(game, roomName);
    }
}

// ⚙️ ฟังก์ชันดึง Effect ออกมาทำงานทีละอัน
function resolveNextEffect(game, roomName) {
    // ถ้าคิวว่าง แปลว่าทำงานจบหมดแล้ว
    if (game.effectStack.length === 0) {
        game.isResolvingStack = false;
        broadcastGameState(roomName, game);
        return;
    }

    game.isResolvingStack = true;
    
    // 🧮 ดึง Effect ใบบนสุด (หลังสุด) ออกมาทำงานแบบ LIFO
    let currentEffect = game.effectStack.pop();
    
    console.log(`▶️ [Stack Resolve] ดำเนินการ [${currentEffect.card.name}] (${currentEffect.triggerType})`);

    let pState = game.players[currentEffect.playerRole];
    
    // 🌟 [แก้บั๊กตรงนี้!] เรียก Ability Engine ให้ประมวลผลการ์ดจริงๆ (ลบ queueEffect อันเก่าทิ้ง)
    processCardAbilities(
        game, 
        currentEffect.playerRole, 
        currentEffect.card, 
        currentEffect.triggerType, 
        currentEffect.contextData.chosenOption || 1, 
        false, 
        io, 
        pState.id
    );

    // 🛑 ตรวจสอบว่าหลังจากรัน Ability แล้ว มีการเปิดหน้าต่าง Modal รอการตัดสินใจจากผู้เล่นหรือไม่?
    if (game.pendingTargetAction || game.reactionWaitingFor || game.pendingScoutData) {
        // ถ้ารออยู่ ให้เบรคระบบไว้แค่นี้ก่อน (พัก Stack)
        console.log(`⏸️ [Stack Paused] ระบบหยุดชั่วคราว รอผู้เล่นตัดสินใจ...`);
        broadcastGameState(roomName, game);
    } else {
        // ถ้าเป็นการ์ดที่ไม่ต้องรอเป้าหมาย ให้วนลูปรันใบทัดไปใน Stack ทันที
        resolveNextEffect(game, roomName);
    }
}

// =========================================================================
// ⚡ ระบบ Advanced React Priority (Chain & Stack Engine)
// =========================================================================

// 1. ฟังก์ชันสร้างหน้าต่างตอบโต้ (เริ่มเข้าสู่ Chain)
function initReactionWindow(game, roomName, activePlayerRole, eventType, eventData, actionMessage) {
    game.reactionContext = {
        originalPlayer: activePlayerRole,
        eventType: eventType,
        eventData: eventData, // เก็บข้อมูล Action ต้นทางไว้
        actionMessage: actionMessage,
        passCount: 0,         // ตัวนับการกด Pass 
        isCancelled: false    // ใช้เช็คว่าถูกยกเลิกหรือไม่
    };
    game.reactionChain = [];  // คิว Stack ของเวทย์ตอบโต้

    // กฎ: เริ่มถามฝ่ายตรงข้ามก่อนเสมอ!
    let opponentRole = activePlayerRole === 'playerA' ? 'playerB' : 'playerA';
    checkAndPromptReaction(game, roomName, opponentRole);
}

// 2. ฟังก์ชันตรวจสอบการ์ดและโยนสิทธิ์
function checkAndPromptReaction(game, roomName, targetPlayerRole) {
    let pState = game.players[targetPlayerRole];
    let context = game.reactionContext;
    if (!context) return;

    // เช็คว่าเรากำลังตอบโต้กับอะไร? (ถ้ามีการ์ดใน Chain แล้วแปลว่าตอบโต้ React Magic ใบล่าสุด)
    let currentEventType = context.eventType;
    let currentMessage = context.actionMessage;

    if (game.reactionChain.length > 0) {
        let topChain = game.reactionChain[game.reactionChain.length - 1];
        currentEventType = 'PLAY_MAGIC';
        currentMessage = `สิทธิ์ตอบโต้: อีกฝ่ายแทรกใช้ React [${topChain.card.name}]`;
    }

    // กรองการ์ดที่ใช้งานได้ในจังหวะนี้
    let validReactCards = pState.hand.filter(c => {
        let isReact = (c.type || '').toLowerCase() === 'magic' && (c.magicSubtype || '').toLowerCase() === 'react';
        if (!isReact) return false;

        let trigger = c.reactCondition || 'UNIVERSAL'; 
        if (currentEventType === 'PLAY_MAGIC' && trigger === 'ON_OPPONENT_MAGIC') return true;
        if (currentEventType === 'SUMMON_AVATAR' && trigger === 'ON_OPPONENT_SUMMON') return true;
        if (currentEventType === 'ATTACK_DECLARED' && trigger === 'ON_OPPONENT_ATTACK') return true;
        if (trigger === 'UNIVERSAL') return true;
        return false;
    });

    if (validReactCards.length > 0) {
        let validReactIds = validReactCards.map(c => c.uniqueId || c.id);
        game.reactionWaitingFor = targetPlayerRole;
        io.to(pState.id).emit('prompt-reaction', { 
            message: currentMessage,
            validReactIds: validReactIds 
        });
    } else {
        // ไม่มีปืนให้ยิง -> ปล่อยผ่านอัตโนมัติ
        handleReactionPass(game, roomName, targetPlayerRole);
    }
}

// 3. ฟังก์ชันจัดการการ Pass สิทธิ์
function handleReactionPass(game, roomName, passingPlayerRole) {
    if (!game.reactionContext) return;
    game.reactionContext.passCount++;
    
    // ถ้า Pass ติดต่อกัน 2 ครั้ง แปลว่าทั้งสองฝ่ายหยุดต่อ Chain แล้ว ให้แสดงผลได้เลย!
    if (game.reactionContext.passCount >= 2) {
        game.reactionWaitingFor = null;
        resolveReactionChain(game, roomName);
    } else {
        // โยนสิทธิ์กลับไปให้อีกฝ่าย (ถ้าตอนแรก B ผ่าน สิทธิ์จะกลับมาที่ A เจ้าของเทิร์นให้ออกอาวุธซ้อนได้!)
        let nextPlayerRole = passingPlayerRole === 'playerA' ? 'playerB' : 'playerA';
        checkAndPromptReaction(game, roomName, nextPlayerRole);
    }
}

// 4. ฟังก์ชันแสดงผล Stack ย้อนหลัง (LIFO)
function resolveReactionChain(game, roomName) {
    console.log(`⛓️ [Resolve Chain] เริ่มแสดงผลตามลำดับ LIFO... (จำนวน: ${game.reactionChain.length})`);
    let chain = game.reactionChain;
    let context = game.reactionContext;

    // วนลูปถอยหลัง (Last In, First Out)
    for (let i = chain.length - 1; i >= 0; i--) {
        let item = chain[i];
        if (item.isCancelled) continue; // ถ้าเวทย์นี้โดน "ชายจากอนาคต" ยกเลิกไปก่อนแล้ว ข้ามไปเลย

        let pState = game.players[item.playerRole];
        let reactText = (item.card.abilityText || "").toLowerCase();
        
        let usageKey = `${item.playerRole}_React`;
        game.magicUsage[usageKey] = true;

        // 🛡️ เคส 1: ยกเลิกเวทมนตร์ (เช่น ชายจากอนาคต)
        if (reactText.includes('ยกเลิก') && reactText.includes('magic')) {
            addGameLog(game, `🛡️ [Chain] ${item.card.name} ยกเลิกเวทมนตร์สำเร็จ!`);
            if (i > 0) {
                // ยกเลิก React ก่อนหน้าในคิว
                chain[i-1].isCancelled = true;
                let cancelledOwner = game.players[chain[i-1].playerRole];
                let mIdx = cancelledOwner.board.magicZone.findIndex(c => c.uniqueId === chain[i-1].card.uniqueId);
                if (mIdx !== -1) cancelledOwner.board.hellZone.push(cancelledOwner.board.magicZone.splice(mIdx, 1)[0]);
            } else if (context.eventType === 'PLAY_MAGIC') {
                // ถ้ายกเลิกเวทย์ตั้งต้นของอีกฝ่าย
                context.isCancelled = true;
                let originalOwner = game.players[context.originalPlayer];
                originalOwner.board.hellZone.push(context.eventData.magicCard);
            }
        }

        // 💥 เคส 2: ทำลายอัญเชิญ (เช่น อุบัติเหตุ)
        else if (reactText.includes('เมื่อ avatar อัญเชิญลงบนสนาม : ทำลาย avatar ตัวนั้น') || reactText.includes('ทำลาย avatar')) {
            if (i === 0 && context.eventType === 'SUMMON_AVATAR') {
                context.isCancelled = true;
                let targetAvatar = context.eventData.summonedCard;
                addGameLog(game, `💥 [Chain] [${item.card.name}] ทำลาย [${targetAvatar.name}] ทันทีที่กำลังลงสนาม!`);
                let originalOwner = game.players[context.originalPlayer];
                originalOwner.board.hellZone.push(targetAvatar);
            }
        }

        // ตั้งเวลาทิ้งการ์ด React ลงนรกหลังจากโชว์บนสนาม
        setTimeout(() => {
            let latestPState = rooms[roomName]?.players[item.playerRole];
            if (latestPState) {
                let mIdx = latestPState.board.magicZone.findIndex(c => c.uniqueId === item.card.uniqueId || c.id === item.card.id);
                if (mIdx !== -1) {
                    latestPState.board.hellZone.push(latestPState.board.magicZone.splice(mIdx, 1)[0]);
                    broadcastGameState(roomName, rooms[roomName]);
                }
            }
        }, 3500);
    }

    // 5. เมื่อรันเวทย์ตอบโต้หมดแล้ว มาตัดสินชะตาของ Action ตั้งต้น!
    if (!context.isCancelled) {
        executePendingAction(roomName, game, context); 
    } else {
        console.log(`🛑 [Action Cancelled] การกระทำต้นทางถูกยกเลิก`);
        game.reactionContext = null;
        game.reactionChain = [];
        broadcastGameState(roomName, game);
        resolveNextEffect(game, roomName);
    }
}

// 🤖 ระบบตรวจสอบความสามารถอัตโนมัติส่วนกลาง (Auto-Trigger Engine)
function triggerAutoAbilities(game, roomName, eventType, eventData) {
    let triggeredCards = [];

    // วนลูปเช็คการ์ดบนบอร์ดของทั้ง 2 ฝ่าย
    ['playerA', 'playerB'].forEach(role => {
        let pState = game.players[role];
        if (!pState || !pState.board || !pState.board.avatarZone) return;

        pState.board.avatarZone.forEach(card => {
            let text = (card.abilityText || "").toLowerCase();
            
            // เช็คว่าการ์ดใบนี้มีคีย์เวิร์ด "อัตโนมัติ" ไหม
            if (!text.includes('อัตโนมัติ')) return;

            let isMatch = false;

            // 🔍 1. เช็คเหตุการณ์: "เมื่อ Avatar ใบนี้โจมตี" (เช่น พระนารายณ์)
            if (eventType === 'EVENT_ATTACK_DECLARED') {
                if (eventData.attackerId === card.uniqueId && text.includes('เมื่อ avatar ใบนี้โจมตี')) {
                    isMatch = true;
                }
            }

            // 🔍 2. เช็คเหตุการณ์: "เมื่อมีการใช้ Magic..." (เช่น จอมเวทย์ เดสสึหวา, ฤษี โคบุตร)
            if (eventType === 'EVENT_MAGIC_PLAYED') {
                // เช็คว่าเวทย์ที่ใช้ตรงกับที่การ์ดต้องการไหม (เช่น {คาถา}, {ฤษี})
                if (text.includes('เมื่อมีการใช้ magic') || text.includes('เมื่อมีการใช้ผลของ magic')) {
                    // ดึงชื่อเผ่าของ Magic จาก Text มาเช็ค (เช่น หาคำว่า "คาถา" หรือ "ฤษี")
                    if (text.includes(eventData.magicSymbol.toLowerCase()) || text.includes(eventData.magicSubtype.toLowerCase())) {
                        isMatch = true;
                    }
                }
            }

            // 🔍 3. เช็คเหตุการณ์: "ในช่วง End Phase" (เช่น นักรบทองแห่งภาคีมะม่วง, โลกิ)
            if (eventType === 'EVENT_END_PHASE') {
                if (text.includes('ในช่วง end phase') || text.includes('ในทุกๆ end phase')) {
                    
                    // เช็คเงื่อนไขย่อย (เช่น ของนักรบทอง ต้องมีต้นมะม่วงบนบอร์ด)
                    if (text.includes('ถ้าบน magic zone เรามี ต้นมะม่วง')) {
                        let hasMangoTree = pState.board.magicZone.some(m => m.name === 'ต้นมะม่วง' || m.name.includes('ต้นมะม่วง'));
                        if (hasMangoTree) isMatch = true;
                    } else {
                        isMatch = true; // ถ้าไม่มีเงื่อนไขย่อยก็ให้ทำงานเลย
                    }
                }
            }

            // 🔍 4. เช็คเหตุการณ์: "เมื่อได้รับ สามัคคี โดย..." (เช่น พี่เจมส์ แก๊งขยะ)
            if (eventType === 'EVENT_RECEIVED_SAMAKKHI') {
                if (eventData.targetId === card.uniqueId && text.includes('เมื่อ avatar ใบนี้ได้รับ สามัคคี')) {
                    // เช็คว่าคนที่ให้สามัคคี ตรงกับชื่อที่ระบุไหม (เช่น พี่ซี๊ด แก๊งขยะ)
                    if (text.includes(eventData.sourceName.toLowerCase())) {
                        isMatch = true;
                    }
                }
            }

            // 🔍 5. เช็คเหตุการณ์: "เมื่อเข้าสู่สถานะ คู่หู"
            if (eventType === 'EVENT_ENTER_LINK') {
                if (eventData.targetId === card.uniqueId && (text.includes('เมื่อ avatar ใบนี้เข้าสู่สถานะ คู่หู') || text.includes('เมื่อเข้าสู่สถานะ คู่หู'))) {
                    isMatch = true;
                }
            }

            // 🎯 ถ้าระบบเจอว่าเงื่อนไขตรง! จับเข้าคิว Effect Stack ทันที
            if (isMatch) {
                console.log(`🤖 [Auto-Trigger] การ์ด [${card.name}] ทำงานอัตโนมัติจากเหตุการณ์ ${eventType}!`);
                
                // ตรวจสอบ "เทิร์นละครั้ง" 
                let isOncePerTurn = text.includes('เทิร์นละครั้ง');
                if (isOncePerTurn) {
                    if (!game.turnUsage) game.turnUsage = {};
                    let usageKey = `${role}_Auto_${card.uniqueId}`;
                    if (game.turnUsage[usageKey] === game.turnCount) return; // ถ้าใช้ไปแล้ว ข้ามเลย
                    game.turnUsage[usageKey] = game.turnCount; // บันทึกว่าใช้แล้ว
                }

                // นำไปต่อคิวใน Stack
                triggeredCards.push({ role, card });
            }
        });
    });

    // โยนการ์ดที่ผ่านเงื่อนไขเข้า Stack ให้หมด
    triggeredCards.forEach(item => {
        queueEffect(game, roomName, item.role, item.card, 'ON_AUTO_TRIGGER');
    });
}

// 🔍 ฟังก์ชันค้นหาประวัติว่าเคยเกิดเหตุการณ์นี้ขึ้นไหมในเทิร์นนี้
// วิธีใช้: checkTurnHistory(game, 'COMBAT_DESTROY', { playerRole: 'playerA', sourceName: 'พระนารายณ์' })
function checkTurnHistory(game, eventType, criteria = {}) {
    if (!game.turnHistory) return false;

    return game.turnHistory.some(event => {
        if (event.type !== eventType) return false;
        
        // เช็คเงื่อนไขย่อย (ถ้ามี)
        for (let key in criteria) {
            // ใช้ .includes() สำหรับชื่อการ์ด เผื่อมีฉายาต่อท้าย
            if (key === 'sourceName' || key === 'targetName') {
                if (!(event[key] || '').includes(criteria[key])) return false;
            } else {
                if (event[key] !== criteria[key]) return false;
            }
        }
        return true;
    });
}

// 🏆 ฟังก์ชันประมวลผลการจบเกม
function triggerGameOver(game, roomName, winnerRole, reason) {
    if (game.isGameOver) return; // ป้องกันการเด้งซ้ำ
    game.isGameOver = true;
    
    console.log(`🏆 [Game Over] ห้อง ${roomName} จบเกมแล้ว! ผู้ชนะคือ ${winnerRole} | เหตุผล: ${reason}`);
    
    // ส่ง Event ตัดจบเกมไปให้ผู้เล่นทั้งสองฝั่ง
    io.to(roomName).emit('game-over', {
        winner: winnerRole,
        reason: reason
    });
}

// 🔍 ฟังก์ชันตรวจสอบเงื่อนไขการจบเกม (Deck Out)
function checkWinConditions(game, roomName) {
    if (game.isGameOver) return;

    let pA = game.players.playerA;
    let pB = game.players.playerB;

    if (pA && pB) {
        let pA_DeckOut = pA.deck.length === 0;
        let pB_DeckOut = pB.deck.length === 0;

        // 🛑 กฎ: จำนวนการ์ดใน Deck เป็น 0 นับจากตอนที่หมดทันที[cite: 5]
        if (pA_DeckOut && pB_DeckOut) {
            triggerGameOver(game, roomName, 'DRAW', 'การ์ดใน Deck หมดพร้อมกันทั้งสองฝ่าย!');
        } else if (pA_DeckOut) {
            triggerGameOver(game, roomName, 'playerB', 'ฝ่ายตรงข้ามการ์ดใน Deck หมด!');
        } else if (pB_DeckOut) {
            triggerGameOver(game, roomName, 'playerA', 'ฝ่ายตรงข้ามการ์ดใน Deck หมด!');
        }
    }
}

// 🔍 ระบบกลาง: ฟังก์ชันตรวจสอบการ์ดในโซนต่างๆ (Universal Zone Checker)
// วิธีใช้: checkZoneCards(pState, 'avatarZone', { name: 'ชมพู' })
function checkZoneCards(playerState, zoneName, criteria = {}) {
    if (!playerState || !playerState.board) return [];
    
    let zoneArray = [];
    if (zoneName === 'avatarZone') zoneArray = playerState.board.avatarZone || [];
    else if (zoneName === 'magicZone') zoneArray = playerState.board.magicZone || [];
    else if (zoneName === 'hellZone') zoneArray = playerState.board.hellZone || [];
    else if (zoneName === 'constructZone') zoneArray = playerState.board.constructZone || [];
    else if (zoneName === 'darkDimensionZone') zoneArray = playerState.board.darkDimensionZone || [];
    else if (zoneName === 'hand') zoneArray = playerState.hand || [];
    else if (zoneName === 'deck') zoneArray = playerState.deck || [];

    // กรองการ์ดในโซนนั้นตามเงื่อนไขที่ระบุมา
    return zoneArray.filter(card => {
        let match = true;
        // เช็คชื่อการ์ด (เช่น หาคำว่า 'ชมพู')
        if (criteria.name && !(card.name || '').includes(criteria.name)) match = false;
        // เช็คประเภทการ์ด (Avatar, Magic, Construct)
        if (criteria.type && (card.type || '').toLowerCase() !== criteria.type.toLowerCase()) match = false;
        // เช็ค Cost (เช่น ห้ามเกิน 5)
        if (criteria.costLimit !== undefined && (card.cost || 0) > criteria.costLimit) match = false;
        // เช็คสัญลักษณ์/เผ่า
        if (criteria.symbol && card.symbol !== criteria.symbol) match = false;
        
        return match;
    });
}

// 🟢 เพิ่มส่วนนี้: ฟังก์ชันประมวลผลความสามารถของ LIFE Card เมื่อถูกหงาย
function processLifeCardEffect(game, roomName, ownerRole, lifeCard) {
    let pState = game.players[ownerRole];
    
    // ดึง Text ความสามารถของการ์ดออกมาอ่าน
    let abilityText = (lifeCard.abilityText || "").toLowerCase();
    
    console.log(`❤️ [LIFE Effect] การ์ด [${lifeCard.name}] ถูกหงาย: ${abilityText}`);
    
    // 1. ความสามารถ: "ใน main phase ถัดไป จั่วการ์ด 1 ใบ" (พวกซีรีส์ "ไม่นะ...!")
    if (abilityText.includes('ใน main phase ถัดไป จั่วการ์ด 1 ใบ')) {
        if (!pState.pendingLifeDraws) pState.pendingLifeDraws = 0;
        pState.pendingLifeDraws += 1;
        
        addGameLog(game, `✨ [LIFE] [${lifeCard.name}] ทำงาน! ${ownerRole} จะได้จั่วการ์ดโบนัสใน Main Phase ถัดไป`);
    }
    
    // 2. ความสามารถ: "อัญเชิญ Avatar สีม่วง ที่ Cost 4 หรือต่ำกว่า 1 ใบ จากมือ" (ไม่นะ เตียวเสียน!)
    else if (abilityText.includes('อัญเชิญ avatar สีม่วง ที่ cost 4 หรือต่ำกว่า')) {
        let validAvatars = pState.hand.filter(c => 
            (c.type || '').toLowerCase() === 'avatar' &&
            (c.color || '').toLowerCase() === 'ม่วง' &&
            (c.cost || 0) <= 4
        );

        if (validAvatars.length > 0 && io) {
            game.pendingTargetAction = { 
                effectType: 'SUMMON_FROM_HAND_FREE', 
                playerRole: ownerRole 
            };
            
            // รอจังหวะ 0.5 วินาทีเพื่อให้หน้าจอฝั่งนู้นอัปเดตการหงายการ์ดก่อนเด้ง Modal
            setTimeout(() => {
                io.to(pState.id).emit('request-target', {
                    message: `❤️ LIFE Effect [${lifeCard.name}]: เลือก Avatar สีม่วง Cost <= 4 จากมือ 1 ใบเพื่ออัญเชิญลงสนามฟรี!`,
                    validTargets: validAvatars,
                    maxSelect: 1,
                    context: 'SUMMON_FROM_HAND_FREE'
                });
            }, 500);
        } else {
            addGameLog(game, `✨ [LIFE] [${lifeCard.name}] ทำงาน! แต่ ${ownerRole} ไม่มีการ์ดในมือที่ตรงเงื่อนไข`);
        }
    }
}

app.use(express.static(__dirname, { index: 'login.html' }));

let rooms = {};
// 🛡️ ฟังก์ชันเช็คว่ากระดานกำลังล็อคอยู่หรือไม่ (ป้องกันผู้เล่นกดยัดคำสั่ง)
function isGameBusy(game) {
    // อนุญาตให้รอเฉพาะตอนที่กำลังรอฝ่ายตรงข้ามใช้ React เท่านั้น
    return game.reactionWaitingFor !== null;
}
let activeRooms = {}; 

io.on('connection', (socket) => {
    socket.on('user-login', ({ username }, callback) => {
        console.log(`> ผู้เล่น ${username} พยายามล็อกอิน`);
        callback({ success: true }); 
    });

    console.log(`> ผู้เล่นเชื่อมต่อสำเร็จ: ${socket.id}`);

    // 🛑 ตรวจสอบเมื่อผู้เล่นตัดการเชื่อมต่อ (ปิดเว็บ/ปิดแท็บ/หลุด)
    socket.on('disconnect', () => {
        console.log(`> ผู้เล่นตัดการเชื่อมต่อ: ${socket.id}`);

        for (let roomName in rooms) {
            let game = rooms[roomName];
            if (game && game.players) {
                let isPlayerInRoom = false;

                if (game.players.playerA && game.players.playerA.id === socket.id) {
                    game.players.playerA = null;
                    isPlayerInRoom = true;
                }
                if (game.players.playerB && game.players.playerB.id === socket.id) {
                    game.players.playerB = null;
                    isPlayerInRoom = true;
                }

                if (isPlayerInRoom) {
                    console.log(`🗑️ [ลบห้อง] ทำการลบห้อง [${roomName}] เนื่องจากผู้เล่นตัดการเชื่อมต่อ`);
                    
                    // 🛑 แจ้งเตือนและเตะผู้เล่นทุกคนในห้องให้กลับหน้า Lobby
                    io.to(roomName).emit('kick-to-lobby', 'ฝ่ายตรงข้ามตัดการเชื่อมต่อ ห้องถูกปิด');
                    
                    delete rooms[roomName];
                    delete activeRooms[roomName];

                    io.emit('update-room-list', activeRooms);
                    break;
                }
            }
        }
    });

    socket.emit('update-room-list', activeRooms);

    socket.on('request-game-state', (roomName) => {
        let game = rooms[roomName];
        if (game) {
            socket.emit('game-state-update', game);
        }
    });

    // ระบบสร้างห้อง: กำหนดค่าเริ่มต้นผู้เล่นเป็น 0
    socket.on('create-room', (roomName) => {
        if (!rooms[roomName]) {
            rooms[roomName] = {
                id: roomName,
                turnCount: 1,
                currentPhase: 'DRAW_PHASE',
                magicUsage: {},
                turnUsage: {},
                landMagicZone: null, // 👈 เพิ่มช่อง Land Magic Zone ตรงกลาง
                players: { playerA: null, playerB: null },
                pendingAction: null,
                reactionWaitingFor: null,
                pendingTargetAction: null,
                actionLog: [],
                effectStack: [],
                isResolvingStack: false
            };
            activeRooms[roomName] = { name: roomName, playersCount: 0 };
            socket.emit('room-created', roomName);
            io.emit('update-room-list', activeRooms);
        }
    });

    function shuffleDeck(deckArray) {
        for (let i = deckArray.length - 1; i > 0; i--) {
            let j = Math.floor(Math.random() * (i + 1));
            [deckArray[i], deckArray[j]] = [deckArray[j], deckArray[i]];
        }
        return deckArray;
    }

    // 🛡️ ฟังก์ชันช่วยส่งการ์ด Modification ที่สวมใส่อยู่ลงนรกพร้อมกับ Avatar
    function removeAvatarWithEquipments(game, roomName, playerRole, avatarIndex) {
        let playerState = game.players[playerRole];
        let removedAvatar = playerState.board.avatarZone.splice(avatarIndex, 1)[0];
        playerState.board.hellZone.push(removedAvatar);

        // 🌟 เอาความสามารถ "คำสั่งเสีย" (ON_DESTROYED) ยัดลง Stack เสมอเมื่อมีตัวตาย
        queueEffect(game, roomName, playerRole, removedAvatar, 'ON_DESTROYED');

        if (removedAvatar.equippedCards && removedAvatar.equippedCards.length > 0) {
            removedAvatar.equippedCards.forEach(modCard => {
                let magicIndex = playerState.board.magicZone.findIndex(m => m.uniqueId === modCard.uniqueId || m.id === modCard.id);
                if (magicIndex !== -1) {
                    let paidMod = playerState.board.magicZone.splice(magicIndex, 1)[0];
                    playerState.board.hellZone.push(paidMod);
                    console.log(`🪦 [Modification ลงนรก] การ์ดสวมใส่ [${paidMod.name}] ลงนรกตาม [${removedAvatar.name}] สำเร็จ`);
                }
            });
        }
    }

    socket.on('join-room', (data) => {
        let roomName = (typeof data === 'object' && data !== null) ? data.room : data;
        let game = rooms[roomName];

        if (game) {
            socket.join(roomName);

            let assignedRole = null;

            if (!game.players.playerA) {
                let rawDeck = (typeof data === 'object' && data.deck) ? [...data.deck] : [];
                game.players.playerA = { 
                    id: socket.id, 
                    hand: [], 
                    deck: rawDeck.map((c, idx) => {
                        let enriched = enrichCardData(c);
                        return {
                            ...enriched,
                            uniqueId: `${enriched.id}_A_${idx}_${Math.random().toString(36).substr(2, 9)}` // 👈 สร้าง ID เฉพาะตัวไม่ซ้ำกันแม้ชื่อเหมือนกัน
                        };
                    }),
                    board: { avatarZone: [], magicZone: [], hellZone: [], darkDimensionZone: [], constructZone: [] }, 
                    lifeZone: [] 
                };
                assignedRole = 'playerA';
            } else if (!game.players.playerB && game.players.playerA.id !== socket.id) {
                let rawDeck = (typeof data === 'object' && data.deck) ? [...data.deck] : [];
                game.players.playerB = { 
                    id: socket.id, 
                    hand: [], 
                    deck: rawDeck.map((c, idx) => {
                        let enriched = enrichCardData(c);
                        return {
                            ...enriched,
                            uniqueId: `${enriched.id}_B_${idx}_${Math.random().toString(36).substr(2, 9)}` // 👈 สร้าง ID เฉพาะตัวสำหรับ Player B
                        };
                    }),
                    board: { avatarZone: [], magicZone: [], hellZone: [], darkDimensionZone: [], constructZone: [] }, 
                    lifeZone: [] 
                };
                assignedRole = 'playerB';
                game.activePlayer = 'playerA';
            } else if (game.players.playerA && game.players.playerA.id === socket.id) {
                assignedRole = 'playerA';
            } else if (game.players.playerB && game.players.playerB.id === socket.id) {
                assignedRole = 'playerB';
            }

            let currentCount = 0;
            if (game.players.playerA) currentCount++;
            if (game.players.playerB) currentCount++;
            if (activeRooms[roomName]) {
                activeRooms[roomName].playersCount = currentCount;
            }

            io.emit('update-room-list', activeRooms);

            // 🛑 เมื่อผู้เล่นครบ 2 คนและเกมยังไม่เริ่ม
            if (game.players.playerA && game.players.playerB && !game.isStarted) {
                game.isStarted = true;
                
                // วนลูปจัดการผู้เล่นทั้งสองฝั่ง (playerA และ playerB)
                ['playerA', 'playerB'].forEach(role => {
                    let pState = game.players[role];

                    // 1. สับเด็คก่อน
                    pState.deck = shuffleDeck(pState.deck);

                    // 2. แยกการ์ดประเภท Life ออกมาจากเด็ค 5 ใบ (ถ้าในเด็คมีไม่พอ ค่อยหยิบจากการ์ดใบบนสุดแทน)
                    let lifeCards = pState.deck.filter(c => c.type && c.type.toLowerCase() === 'life');
                    
                    
                    for (let i = 0; i < 5; i++) {
                        let lifeCard;
                        if (lifeCards.length > 0) {
                            lifeCard = lifeCards.shift();
                            // ลบการ์ดใบนั้นออกจากเด็คหลัก
                            let indexInDeck = pState.deck.findIndex(c => c.id === lifeCard.id);
                            if (indexInDeck !== -1) pState.deck.splice(indexInDeck, 1);
                        } else if (pState.deck.length > 0) {
                            // ถ้าการ์ด Life ในเด็คไม่พอ 5 ใบ ให้หยิบบนสุดแทนสำรองไว้
                            lifeCard = pState.deck.pop();
                        }
                    
                        if (lifeCard) {
                            pState.lifeZone.push({
                                ...lifeCard,
                                isRevealed: false
                            });
                        }
                    }

                    // 3. จั่วการ์ดขึ้นมือ 5 ใบจากเด็คที่เหลือ (พร้อมผูกค่า gem ให้การ์ดทุกใบ)
                    for (let i = 0; i < 5; i++) {
                        if (pState.deck.length > 0) {
                            let drawnCard = pState.deck.pop();
                            
                            // 🛑 บังคับเช็คและกำหนดค่า gem ให้การ์ด (ถ้าการ์ดไม่มี .gem ให้ดึงจาก .cost หรือเซ็ตเป็น 0)
                            if (drawnCard.gem === undefined || drawnCard.gem === null) {
                                drawnCard.gem = Number(drawnCard.cost) || 0;
                            }
                            
                            pState.hand.push(drawnCard);
                        }
                    }
                });

                console.log(`🎮 ผู้เล่นครบ 2 คน! สับเด็ค, แยก Life 5 ใบ และจั่วการ์ดขึ้นมือเรียบร้อยในห้อง [${roomName}][cite: 13, 16]`);
                
                io.to(game.players.playerA.id).emit('assign-role', { role: 'playerA' });
                io.to(game.players.playerB.id).emit('assign-role', { role: 'playerB' });
                io.to(roomName).emit('game-start', game);
            } else {
                if (assignedRole) {
                    socket.emit('assign-role', { role: assignedRole });
                }
                socket.emit('game-state-update', game);
            }
        } else {
            socket.emit('error-message', 'ไม่พบห้องนี้อยู่');
        }
    });
    // -------------------------------------------------------------------------
    // 🏗️ ระบบก่อสร้างการ์ด Construct (Construct Building Step)
    // -------------------------------------------------------------------------
    socket.on('construct-card', ({ roomName, playerRole, cardId, sacrificeCardIds }) => {
        let game = rooms[roomName];
        if (!game || game.activePlayer !== playerRole) return;

        let pState = game.players[playerRole];
        let cardIndex = pState.hand.findIndex(c => c.uniqueId === cardId || c.id === cardId);
        if (cardIndex === -1) return;

        let cardToConstruct = pState.hand[cardIndex];

        // 🛑 กฎ: ตรวจสอบว่าเป็นประเภท Construct จริงหรือไม่
        let cType = (cardToConstruct.type || '').trim().toLowerCase();
        if (cType !== 'construct') {
            socket.emit('error-message', 'Construct Zone สามารถลงได้เฉพาะการ์ดประเภท Construct เท่านั้น!');
            return;
        }

        // 🛑 กฎ: Construct Zone มีได้สูงสุด 3 ใบ[cite: 15]
        if (!pState.board.constructZone) {
            pState.board.constructZone = [];
        }
        if (pState.board.constructZone.length >= 3) {
            socket.emit('error-message', 'Construct Zone เต็มแล้ว (สูงสุด 3 ใบ)');
            return;
        }

        // 🛑 กฎ: การ์ดบน Construct Zone ต้องมีชื่อไม่ซ้ำกัน[cite: 15]
        let isNameDuplicate = pState.board.constructZone.some(c => c.name === cardToConstruct.name);
        if (isNameDuplicate) {
            socket.emit('error-message', `ไม่สามารถก่อสร้างการ์ดชื่อซ้ำกันใน Construct Zone ได้ ([${cardToConstruct.name}])`);
            return;
        }

        let requiredCost = cardToConstruct.cost || 0;
        let chosenSacrifices = sacrificeCardIds || [];

        // Cost Step: จ่าย GEM ถ้า Cost > 0
        if (requiredCost > 0) {
            let totalGemPaid = 0;
            let tempSacrifices = [];

            for (let sId of chosenSacrifices) {
                let sIndex = pState.hand.findIndex(c => c.uniqueId === sId || c.id === sId);
                if (sIndex !== -1) {
                    let sCard = pState.hand[sIndex];
                    let gemVal = Number(sCard.gem) || 0;
                    totalGemPaid += gemVal;
                    tempSacrifices.push(sIndex);
                }
            }

            if (totalGemPaid < requiredCost) {
                socket.emit('error-message', `GEM ที่ใช้จ่ายไม่พอสำหรับการก่อสร้าง (ต้องการ ${requiredCost}, จ่ายไป ${totalGemPaid})`);
                return;
            }

            // ส่งการ์ดที่ใช้จ่าย GEM ลง Hell Zone (นรก)
            tempSacrifices.sort((a, b) => b - a);
            tempSacrifices.forEach(sIdx => {
                let paidCard = pState.hand.splice(sIdx, 1)[0];
                pState.board.hellZone.push(paidCard);
            });
        }

        // Construct Build Step: นำการ์ด Construct ออกจากมือและวางลง Construct Zone
        let finalCardIndex = pState.hand.findIndex(c => c.uniqueId === cardId || c.id === cardId);
        let constructedCard = pState.hand.splice(finalCardIndex, 1)[0];
        
        constructedCard.isResting = false;
        pState.board.constructZone.push(constructedCard);

        console.log(`🏗️ [Construct สำเร็จ] ผู้เล่น ${playerRole} ก่อสร้าง [${constructedCard.name}] ลง Construct Zone สำเร็จ`);
        broadcastGameState(roomName, game);
    });

    // 🛑 ระบบรับข้อมูล Mulligan จากผู้เล่น
    socket.on('player-mulligan', ({ roomName, playerRole, returnedCardIds }) => {
        let game = rooms[roomName];
        if (!game || !game.players[playerRole]) return;

        let pState = game.players[playerRole];

        if (!pState.hasMulligated) {
            pState.hasMulligated = true;

            // 1. นำการ์ดที่เลือกทิ้งกลับเข้าเด็ค
            returnedCardIds.forEach(cardId => {
                let index = pState.hand.findIndex(c => c.id === cardId);
                if (index !== -1) {
                    let removedCard = pState.hand.splice(index, 1)[0];
                    pState.deck.push(removedCard);
                }
            });

            // 2. สับเด็คใหม่
            pState.deck = shuffleDeck(pState.deck);

            // 3. จั่วการ์ดกลับมาตามจำนวนที่ทิ้งไป
            let drawCount = returnedCardIds.length;
            for (let i = 0; i < drawCount; i++) {
                if (pState.deck.length > 0) {
                    pState.hand.push(pState.deck.pop());
                }
            }
        }
        addGameLog(game, `${playerRole} ทำการ Mulligan`);

        let playerA_done = game.players.playerA && game.players.playerA.hasMulligated;
        let playerB_done = game.players.playerB && game.players.playerB.hasMulligated;

        if (playerA_done && playerB_done && !game.mulliganCompleted) {
            game.mulliganCompleted = true;
            
            // 🎲 สุ่มเลือกผู้เล่นเริ่มต้นคนแรกหลัง Mulligan เสร็จ (เลือก playerA หรือ playerB)
            let roles = ['playerA', 'playerB'];
            game.activePlayer = roles[Math.floor(Math.random() * roles.length)];

            // 🛑 บันทึกว่าใครคือคนแรก และใครคือคนทีหลัง พร้อมเริ่มที่เทิร์น 1
            game.firstPlayer = game.activePlayer;
            game.secondPlayer = (game.firstPlayer === 'playerA') ? 'playerB' : 'playerA';
            game.turnCount = 1;

            console.log(`✨ [Mulligan เสร็จสิ้น] สุ่มให้ผู้เล่น [${game.activePlayer}] เป็นฝ่ายเริ่มเล่นก่อนในห้อง [${roomName}]`);
        }

        broadcastGameState(roomName, game);
    });
    // 🌌 ฟังก์ชันเนรเทศการ์ดเข้า Dark Dimension Zone (มิติมืด)
    function banishCard(game, playerRole, card) {
       let pState = game.players[playerRole];
       if (!pState) return;

       if (!pState.board.darkDimensionZone) {
           pState.board.darkDimensionZone = [];
        }

       pState.board.darkDimensionZone.push(card);
       console.log(`🌌 [Dark Dimension] การ์ด [${card.name}] ของผู้เล่น [${playerRole}] ถูกเนรเทศไปยังมิติมืดแล้ว`);
    }

    // -------------------------------------------------------------------------
    // 1. ระบบจัดการการอัญเชิญ Avatar (อ่านค่า GEM จากการ์ดจริงตาม cards.json)
    // -------------------------------------------------------------------------
    socket.on('summon-avatar', ({ roomName, playerRole, cardId, sacrificeCardIds }) => {
        let game = rooms[roomName];
        if (!game || game.activePlayer !== playerRole) return;

        // 🛑 [เพิ่มบรรทัดนี้] ล็อคไม่ให้อัญเชิญถ้าระบบติดพันอยู่
        if (isGameBusy(game)) {
            return socket.emit('error-message', '⏳ กรุณารอให้อีกฝ่ายตัดสินใจ หรือรอระบบประมวลผลให้เสร็จก่อน!');
        }

        let pState = game.players[playerRole];
        let cardIndex = pState.hand.findIndex(c => c.uniqueId === cardId || c.id === cardId);
        if (cardIndex === -1) return;

        let cardToSummon = pState.hand[cardIndex];

        if (pState.board.avatarZone.length >= 4) {
            socket.emit('error-message', 'Avatar Zone เต็มแล้ว (สูงสุด 4 ใบ)');
            return;
        }

        let requiredCost = cardToSummon.cost || 0;
        let chosenSacrifices = sacrificeCardIds || [];

        if (requiredCost > 0) {
            let totalGemPaid = 0;
            let tempSacrifices = [];

            for (let sId of chosenSacrifices) {
                let sIndex = pState.hand.findIndex(c => c.uniqueId === sId || c.id === sId);
                if (sIndex !== -1) {
                    let sCard = pState.hand[sIndex];
                    let gemVal = Number(sCard.gem) || 0;
                    totalGemPaid += gemVal;
                    tempSacrifices.push(sIndex);
                }
            }

            if (totalGemPaid < requiredCost) {
                socket.emit('error-message', `GEM ที่ใช้จ่ายไม่พอ (ต้องการ ${requiredCost}, จ่ายไป ${totalGemPaid})`);
                return;
            }

            tempSacrifices.sort((a, b) => b - a);
            tempSacrifices.forEach(sIdx => {
                let paidCard = pState.hand.splice(sIdx, 1)[0];
                pState.board.hellZone.push(paidCard);
            });
        }

        let finalCardIndex = pState.hand.findIndex(c => c.uniqueId === cardId || c.id === cardId);
        if (finalCardIndex !== -1) {
            let summonedCard = pState.hand.splice(finalCardIndex, 1)[0];
            summonedCard.isResting = false;
            
            let actionData = {
                type: 'SUMMON_AVATAR',
                playerRole: playerRole,
                summonedCard: summonedCard
            };

            addGameLog(game, `⚠️ ${playerRole} กำลังจะอัญเชิญ [${summonedCard.name}]...`);

            // ⚡ โยนเข้า React Chain Engine (ระบบใหม่จะจัดการเช็คเวทย์และเอาการ์ดลงบอร์ดให้เอง)
            initReactionWindow(game, roomName, playerRole, 'SUMMON_AVATAR', actionData, `ฝ่ายตรงข้ามอัญเชิญ [${summonedCard.name}]`);

            broadcastGameState(roomName, game);
        } 
    });

    // -------------------------------------------------------------------------
    // ⚙️ ระบบ "สั่งใช้" ความสามารถครอบจักรวาล (Avatar, Hand, Hell, Construct, Land)
    // -------------------------------------------------------------------------
    socket.on('activate-ability', ({ roomName, playerRole, cardId, sourceZone }) => {
        let game = rooms[roomName];
        if (!game || game.activePlayer !== playerRole) return;

        // 🛑 [เพิ่มบรรทัดนี้] ล็อคไม่ให้กดสกิลรัวๆ ถ้าระบบติดพันอยู่
        if (isGameBusy(game)) {
            return socket.emit('error-message', '⏳ กรุณารอให้อีกฝ่ายตัดสินใจ หรือรอระบบประมวลผลให้เสร็จก่อน!');
        }

        let pState = game.players[playerRole];
        let activatedCard = null;

        let allZones = [pState.board.avatarZone, pState.hand, pState.board.constructZone, pState.board.hellZone, pState.board.darkDimensionZone, pState.board.magicZone];
        for (let zone of allZones) {
            if (!zone) continue;
            let found = zone.find(c => c.uniqueId === cardId || c.id === cardId);
            if (found) { activatedCard = found; break; }
        }

        if (!activatedCard && game.landMagicZone && game.landMagicZone.card) {
            if (game.landMagicZone.card.uniqueId === cardId || game.landMagicZone.card.id === cardId) {
                activatedCard = game.landMagicZone.card;
            }
        }

        if (!activatedCard) return;

        // 🛡️ [เช็คที่ 1] ตรวจสอบโซนที่อนุญาตให้ใช้งาน (Anti-Cheat Zone)
        let abilityStruct = activatedCard.structuredAbilities || [];
        let matchedAbility = abilityStruct.find(a => a.trigger === 'ON_ACTIVATE');

        if (matchedAbility && matchedAbility.requiredZone) {
            let allowedZone = matchedAbility.requiredZone;
            let currentZoneType = 'AVATAR_ZONE';
            if (sourceZone === 'hand') currentZoneType = 'HAND';
            else if (sourceZone === 'hell') currentZoneType = 'HELL_ZONE';
            else if (sourceZone === 'construct') currentZoneType = 'CONSTRUCT_ZONE';

            if (allowedZone !== currentZoneType && allowedZone !== 'AVATAR_ZONE') {
                socket.emit('error-message', `❌ ไม่สามารถใช้งานความสามารถนี้จากโซนนี้ได้ (ต้องใช้จาก ${allowedZone})!`);
                return;
            }
        }

        // 🧠 [เช็คที่ 2] ตรวจสอบเงื่อนไขซับซ้อน (เคส พระนารายณ์)
        let text = (activatedCard.abilityText || "").toLowerCase();
        if (text.includes('หลังจากที่การ์ดต่อสู้') || text.includes('ทำลาย avatar อีกฝ่าย')) {
            
            // ใช้ระบบความจำสืบค้นว่าในเทิร์นนี้ พระนารายณ์ฝ่ายเราตีใครตายไปบ้างหรือยัง?
            let hasNarayanKilled = checkTurnHistory(game, 'COMBAT_DESTROY', { 
                playerRole: playerRole, 
                sourceName: 'พระนารายณ์' 
            });

            if (!hasNarayanKilled) {
                socket.emit('error-message', '❌ เงื่อนไขไม่ครบ: Avatar "พระนารายณ์" ของคุณยังไม่ได้ต่อสู้ทำลาย Avatar อีกฝ่ายในเทิร์นนี้!');
                return;
            }
            
            if (text.includes('ส่ง avatar "พระนารายณ์"') && text.includes('ลงนรก')) {
                let validNarayanOnBoard = pState.board.avatarZone.filter(a => a.name.includes('พระนารายณ์'));
                
                if (validNarayanOnBoard.length === 0) {
                    socket.emit('error-message', '❌ เงื่อนไขไม่ครบ: ไม่มี Avatar "พระนารายณ์" บนสนามให้ส่งลงนรก!');
                    return;
                }

                // สั่งเปิดหน้าต่างให้ผู้เล่นเลือกเป้าหมายส่งลงนรก
                game.pendingTargetAction = {
                    effectType: 'SEND_NARAYAN_TO_HELL_AND_SUMMON',
                    playerRole: playerRole,
                    cardToActivateId: activatedCard.uniqueId || activatedCard.id
                };

                io.to(socket.id).emit('request-target', {
                    message: `✨ สั่งใช้ [${activatedCard.name}]: เลือก "พระนารายณ์" บนสนาม 1 ใบส่งลงนรกเป็นค่า Cost`,
                    validTargets: validNarayanOnBoard,
                    maxSelect: 1,
                    context: 'SEND_NARAYAN_TO_HELL'
                });
                return; // 🛑 หยุดรันต่อ รอจนกว่าผู้เล่นจะเลือกเป้าหมาย!
            }
        }

        console.log(`✨ [Activated Ability] ผู้เล่น ${playerRole} สั่งใช้ความสามารถของ [${activatedCard.name}] จากโซน [${sourceZone}]`);
        let triggerType = 'ON_ACTIVATE';
        if (sourceZone === 'hand') triggerType = 'ON_ACTIVATE_FROM_HAND';
        if (sourceZone === 'hell') triggerType = 'ON_ACTIVATE_FROM_HELL';

        queueEffect(game, roomName, playerRole, activatedCard, triggerType);
        broadcastGameState(roomName, game);
    });

    // 🎯 ระบบรับข้อมูลเป้าหมายที่ผู้เล่นเลือก และประมวลผลผลลัพธ์
    socket.on('submit-target', ({ roomName, playerRole, targetCardIds, context }) => {
        let game = rooms[roomName];
        if (!game || !game.pendingTargetAction) return;

        let pState = game.players[playerRole];
        let opponentRole = playerRole === 'playerA' ? 'playerB' : 'playerA';
        let oppState = game.players[opponentRole];

        let action = game.pendingTargetAction;

        // 🛑 ถ้ายกเลิกการเลือกเป้าหมาย (targetCardIds ว่างเปล่า)
        if (targetCardIds.length === 0) {
            console.log(`❌ [Target Selection] ผู้เล่น ${playerRole} ยกเลิกการเลือกเป้าหมาย`);
            game.pendingTargetAction = null;
            
            // 🌟 เช็คว่าเป็นการปฏิเสธ "โล่มนุษย์" ใช่หรือไม่?
            if (action.effectType === 'HUMAN_SHIELD') {
                addGameLog(game, `⏩ ปล่อยผ่านการโจมตี ไม่ใช้โล่มนุษย์`);
                executeCombatPhase(game, roomName); // <--- สั่งให้ตีเป้าหมายเดิมให้จบ!
            } else {
                // ถ้าเป็นการยกเลิกสกิลหรือเวทมนตร์ ปล่อยคิวข้ามไปเลย
                broadcastGameState(roomName, game);
                resolveNextEffect(game, roomName);
            }
            return; // จบการทำงาน
        }

        // ⚙️ แยกการทำงานตาม Effect Type ที่กำหนดไว้ใน Context
        switch (action.effectType) {

            // เคส 1: ทำลาย Avatar ฝ่ายตรงข้าม
            case 'DESTROY_OPPONENT_AVATAR':
                targetCardIds.forEach(tId => {
                    let idx = oppState.board.avatarZone.findIndex(c => c.uniqueId === tId || c.id === tId);
                    if (idx !== -1) {
                        removeAvatarWithEquipments(game, roomName, opponentRole, idx);
                        console.log(`💥 [Resolve Target] ผู้เล่น ${playerRole} ทำลาย Avatar ฝ่ายตรงข้ามสำเร็จ`);
                    }
                });
                break;

            // เคส 2: นำการ์ดบนสนาม หรือขุดจากนรก กลับขึ้นมือ
            case 'RETURN_TO_HAND':
                targetCardIds.forEach(tId => {
                    let myIdx = pState.board.avatarZone.findIndex(c => c.uniqueId === tId || c.id === tId);
                    if (myIdx !== -1) {
                        let returnedCard = pState.board.avatarZone.splice(myIdx, 1)[0];
                        pState.hand.push(returnedCard);
                        console.log(`📤 [Resolve Target] เด้งการ์ดบนสนามกลับขึ้นมือสำเร็จ`);
                        return; 
                    } 
                    
                    let oppIdx = oppState.board.avatarZone.findIndex(c => c.uniqueId === tId || c.id === tId);
                    if (oppIdx !== -1) {
                        let returnedCard = oppState.board.avatarZone.splice(oppIdx, 1)[0];
                        oppState.hand.push(returnedCard);
                        console.log(`📤 [Resolve Target] เด้งการ์ดศัตรูกลับขึ้นมือสำเร็จ`);
                        return;
                    }

                    let hellIdx = pState.board.hellZone.findIndex(c => c.uniqueId === tId || c.id === tId);
                    if (hellIdx !== -1) {
                        let returnedCard = pState.board.hellZone.splice(hellIdx, 1)[0];
                        pState.hand.push(returnedCard);
                        addGameLog(game, `🧟 [ขุดสุสาน] ${playerRole} นำ [${returnedCard.name}] จากนรกขึ้นมือ!`);
                        return;
                    }
                });
                break;

            // เคส 3: แปะบัฟ/ดีบัฟให้ Avatar
            case 'APPLY_BUFF':
                targetCardIds.forEach(tId => {
                    let targetAvatar = pState.board.avatarZone.find(c => c.uniqueId === tId || c.id === tId) || 
                                       oppState.board.avatarZone.find(c => c.uniqueId === tId || c.id === tId);
                    
                    if (targetAvatar) {
                        if (!targetAvatar.tempEffects) targetAvatar.tempEffects = [];
                        targetAvatar.tempEffects.push({ amount: action.buffAmount, expireAt: action.expireAt });
                        let effectTypeStr = action.buffAmount > 0 ? 'เพิ่มพลัง' : 'ลดพลัง';
                        addGameLog(game, `✨ [Effect] ${effectTypeStr} [${targetAvatar.name}] ${action.buffAmount} (ถึง ${action.expireAt})`);
                    }
                });
                break;

            // 🛡️ เคส 4: โล่มนุษย์รับดาเมจแทน (แก้ไขให้กระชับขึ้น)
            case 'HUMAN_SHIELD':
                let shieldId = targetCardIds[0];
                let shieldCard = pState.board.avatarZone.find(c => c.uniqueId === shieldId || c.id === shieldId);
                if (shieldCard) {
                    // เปลี่ยนสถานะเป็นนอน และเปลี่ยนเป้าหมายโจมตีมาที่การ์ดใบนี้แทน
                    shieldCard.isResting = true;
                    game.pendingCombat.targetType = 'avatar';
                    game.pendingCombat.targetId = shieldId;
                    addGameLog(game, `🛡️ [${shieldCard.name}] ใช้ 'โล่มนุษย์' กระโดดรับการโจมตีแทน!`);
                }
                
                game.pendingTargetAction = null;
                // ดำเนินการต่อสู้เป้าหมายใหม่ให้จบ
                executeCombatPhase(game, roomName);
                break;

            // ... (เคส 5 และ เคสอื่นๆ ด้านล่าง คงไว้เหมือนเดิมได้เลยครับ) ...
            case 'SUMMON_FROM_HAND_FREE':
                targetCardIds.forEach(tId => {
                    let handIdx = pState.hand.findIndex(c => c.uniqueId === tId || c.id === tId);
                    if (handIdx !== -1) {
                        let summonedCard = pState.hand.splice(handIdx, 1)[0];
                        summonedCard.isResting = false;
                        pState.board.avatarZone.push(summonedCard);
                        addGameLog(game, `✨ [LIFE Bonus] ${playerRole} อัญเชิญฟรี [${summonedCard.name}] ลงสนาม!`);
                    }
                });
                break;
            
            case 'SEND_NARAYAN_TO_HELL_AND_SUMMON':
                targetCardIds.forEach(tId => {
                    let idx = pState.board.avatarZone.findIndex(c => c.uniqueId === tId || c.id === tId);
                    if (idx !== -1) {
                        let sentCard = pState.board.avatarZone.splice(idx, 1)[0];
                        pState.board.hellZone.push(sentCard);
                        addGameLog(game, `🪦 ส่ง [${sentCard.name}] ลงนรกเป็น Cost สำเร็จ`);
                    }
                });

                let handIdx = pState.hand.findIndex(c => c.uniqueId === action.cardToActivateId || c.id === action.cardToActivateId);
                if (handIdx !== -1) {
                    let summonedCard = pState.hand.splice(handIdx, 1)[0];
                    summonedCard.isResting = false;
                    pState.board.avatarZone.push(summonedCard);
                    addGameLog(game, `✨ [อัญเชิญร่างอวตาร] นำ [${summonedCard.name}] ลงสู่ Avatar Zone!`);
                    handleNarayanAvatarBonus(game, playerRole, summonedCard, io, socket.id);
                }
                break;

            case 'BANISH_OPPONENT_AVATAR':
                targetCardIds.forEach(tId => {
                    let oppIdx = oppState.board.avatarZone.findIndex(c => c.uniqueId === tId || c.id === tId);
                    if (oppIdx !== -1) {
                        let banishedCard = oppState.board.avatarZone.splice(oppIdx, 1)[0];
                        if (!oppState.board.darkDimensionZone) oppState.board.darkDimensionZone = [];
                        oppState.board.darkDimensionZone.push(banishedCard);
                        addGameLog(game, `🌌 [เนรเทศ] ส่ง [${banishedCard.name}] ไปยัง Dark Dimension สำเร็จ!`);
                    }
                });
                break;

            case 'WAKE_UP_AVATAR':
                targetCardIds.forEach(tId => {
                    let myIdx = pState.board.avatarZone.findIndex(c => c.uniqueId === tId || c.id === tId);
                    if (myIdx !== -1) {
                        pState.board.avatarZone[myIdx].isResting = false;
                        addGameLog(game, `🔆 [ปลุกตื่น] ${pState.board.avatarZone[myIdx].name} เข้าสู่สภาพตื่นแล้ว!`);
                    }
                });
                break;
        }

        // เคลียร์สถานะการรอเป้าหมาย และอัปเดตหน้าจอให้ทั้งสองฝ่าย
        game.pendingTargetAction = null;
        broadcastGameState(roomName, game);
        
        // 🌟 ปลุก Stack ให้ทำงานต่อ (ยกเว้นเคส HUMAN_SHIELD ที่ทำงานจบในตัวไปแล้ว)
        if (action.effectType !== 'HUMAN_SHIELD') {
            resolveNextEffect(game, roomName);
        }
    });

    // 🔍 ระบบรับข้อมูลเมื่อผู้เล่นค้นหาการ์ดจากเด็คสำเร็จ (Deck Search)
    socket.on('submit-deck-search', ({ roomName, playerRole, chosenCardIds, destination }) => {
        let game = rooms[roomName];
        if (!game || !game.players[playerRole]) return;

        let pState = game.players[playerRole];

        chosenCardIds.forEach(cardId => {
            // ดึงการ์ดที่เลือกออกมาจากเด็ค
            let cardIndex = pState.deck.findIndex(c => c.uniqueId === cardId || c.id === cardId);
            if (cardIndex !== -1) {
                let card = pState.deck.splice(cardIndex, 1)[0];
                
                // ตรวจสอบว่าปลายทางให้เอาไปไว้ไหน
                if (destination === 'hand') {
                    pState.hand.push(card);
                    console.log(`🔍 [Deck Search] ผู้เล่น ${playerRole} นำ [${card.name}] ขึ้นมือสำเร็จ`);
                } else if (destination === 'avatarZone') {
                    card.isResting = false;
                    pState.board.avatarZone.push(card);
                } else if (destination === 'hellZone') {
                    pState.board.hellZone.push(card);
                }
            }
        });

        // 📜 กฎ: เมื่อมีการค้นหา หรือ เปิดดูการ์ดใน Private Zone (Deck) จะต้องสับเด็คเสมอ[cite: 5]
        pState.deck = shuffleDeck(pState.deck);
        console.log(`🔀 [Deck Search] สับเด็คของผู้เล่น ${playerRole} เรียบร้อยแล้ว`);

        broadcastGameState(roomName, game);
    });

    // 🛑 รับข้อมูลตัวเลือกจากการเลือกปฏิบัติ (Choice Ability สำหรับทั้ง Avatar และ Magic)
    socket.on('submit-choice', ({ roomName, playerRole, cardId, chosenOption }) => {
        let game = rooms[roomName];
        if (!game || !game.players[playerRole]) return;

        let pState = game.players[playerRole];
        
        // ค้นหาการ์ดเป้าหมาย
        let targetCard = pState.board.avatarZone.find(c => c.uniqueId === cardId || c.id === cardId) || 
                         pState.board.magicZone.find(c => c.uniqueId === cardId || c.id === cardId) || 
                         pState.hand.find(c => c.uniqueId === cardId || c.id === cardId);

        console.log(`🔀 [Choice Executed] ผู้เล่น ${playerRole} เลือกข้อย่อยที่ [${chosenOption}] ของการ์ด [${targetCard ? targetCard.name : cardId}]`);

        if (targetCard) {
            // ดึงข้อความของข้อย่อยที่ผู้เล่นกดเลือกออกมา (เช่น "ถ้าบน Avatar Zone ฝ่ายเรา มี 'เพมมุ'...")
            let options = extractChoiceOptions(targetCard.abilityText || "");
            let selectedText = options[chosenOption - 1] || "";

            // 🧠 1. ระบบอ่าน Text อัตโนมัติ (Dynamic Text Parsing รองรับทั้งชื่อและการ์ดประเภทต่างๆ)
            // รองรับรูปแบบ: อัญเชิญ [ประเภท] "[ชื่อ]" หรือ อัญเชิญ "[ชื่อ]" หรือ นำ [ประเภท] "[ชื่อ]" ขึ้นมือ
            let condMatch = selectedText.match(/ถ้าบน\s*([a-zA-Z\s]+)\s*ฝ่ายเรา\s*มี\s*['"](.+?)['"]/i);
            
            // ปรับ Pattern ให้รองรับคำว่า Avatar หรือ Magic นำหน้าชื่อการ์ด (ถ้ามี)
            let actMatch = selectedText.match(/(?:อัญเชิญ|นำ)\s*(?:Avatar|Magic|Construct)?\s*['"](.+?)['"].*?จาก\s*([a-zA-Z]+).*?(?:ลงบน|ขึ้นมือ)\s*([a-zA-Z\s]+)?/i);

            // ถ้าระบบอ่าน Text ออก และเข้ากับแพทเทิร์นที่ตั้งไว้เป๊ะๆ
            if (condMatch && actMatch) {
                let reqZoneStr = condMatch[1].trim();   // ผลเช่น: "Avatar Zone"
                let reqName = condMatch[2].trim();      // ผลเช่น: "เพมมุ"
                let targetQuery = actMatch[1].trim();   // ผลเช่น: "สไปรท์" (อาจเป็นชื่อ หรือ ประเภทการ์ด)
                let sourceZoneStr = actMatch[2].trim(); // ผลเช่น: "Deck"
                let destZoneStr = (actMatch[3] || "Hand").trim(); // ผลเช่น: "Avatar Zone"

                // แปลงชื่อ Zone Text เป็นชื่อตัวแปรจริงในระบบ
                let internalReqZone = reqZoneStr.toLowerCase().includes('avatar') ? 'avatarZone' : 'magicZone';
                let internalSourceZone = sourceZoneStr.toLowerCase().includes('deck') ? 'deck' : 'hellZone';
                let internalDestZone = destZoneStr.toLowerCase().includes('avatar') ? 'avatarZone' : 'hand';

                console.log(`🤖 [Auto-Parse Advanced] เช็ค "${reqName}" บน ${internalReqZone} -> ค้นหา "${targetQuery}" จาก ${internalSourceZone} ไปยัง ${internalDestZone}`);

                // 1. เช็คว่าบนบอร์ดมีตัวละครเงื่อนไข (เช่น เพมมุ) หรือไม่?
                let hasRequiredCard = checkZoneCards(pState, internalReqZone, { name: reqName }).length > 0;
                
                if (!hasRequiredCard) {
                    io.to(pState.id).emit('error-message', `❌ เงื่อนไขไม่ครบ: ไม่มี "${reqName}" บน ${reqZoneStr} ของคุณ!`);
                } else {
                    // 2. กรองหาการ์ดเป้าหมายจากกอง (เช็คทั้งประเภท Avatar และชื่อการ์ดให้ตรงกัน)
                    let sourceArray = internalSourceZone === 'deck' ? pState.deck : pState.board.hellZone;
                    let validTargets = sourceArray.filter(c => {
                        let cName = (c.name || "").toLowerCase();
                        let cType = (c.type || "").toLowerCase();
                        let query = targetQuery.toLowerCase();
                        
                        // ถ้าปลายทางคือ Avatar Zone จะต้องเป็นประเภท Avatar และมีชื่อตรงกับที่ค้นหา
                        if (internalDestZone === 'avatarZone') {
                            return cType === 'avatar' && cName.includes(query);
                        }
                        
                        // ถ้าเป็นการขึ้นมือทั่วไป ให้เช็คจากชื่อหรือประเภทตามปกติ
                        return cName.includes(query) || cType === query;
                    });

                    if (validTargets.length > 0) {
                        if (internalSourceZone === 'deck') {
                            io.to(pState.id).emit('open-search-deck-modal', {
                                cards: validTargets, 
                                destination: internalDestZone, 
                                maxSelect: 1, 
                                message: `เลือกการ์ด "${targetQuery}" จาก ${sourceZoneStr} 1 ใบเพื่อนำไปที่ ${destZoneStr}`
                            });
                        }
                    } else {
                        io.to(pState.id).emit('error-message', `❌ ค้นหาล้มเหลว: ไม่พบการ์ดที่ตรงกับ "${targetQuery}" ใน ${sourceZoneStr} ของคุณเลย`);
                    }
                }
            } 
            // 🛑 2. ถ้าระบบอ่าน Text ไม่ออก (ใช้กับกรณีพิเศษที่เขียนไม่เหมือนชาวบ้าน เช่น เลือกมันสำหรับพวกจน)
            else if (targetCard.name === 'เลือกมันสำหรับพวก จน !!!') {
                if (chosenOption === 1) {
                    let validTargets = pState.board.hellZone.filter(c => (c.type || '').toLowerCase() === 'avatar' && (c.cost || 0) <= 5 && !(c.special || "").toLowerCase().includes('only'));
                    if (validTargets.length > 0) {
                        game.pendingTargetAction = { effectType: 'RETURN_TO_HAND', playerRole: playerRole };
                        io.to(pState.id).emit('request-target', { message: `เลือก Avatar Cost 5 หรือต่ำกว่า จากนรก 1 ใบขึ้นมือ`, validTargets: validTargets, maxSelect: 1, context: 'RETURN_TO_HAND' });
                    } else { io.to(pState.id).emit('error-message', 'ไม่มีเป้าหมายในนรกที่ตรงเงื่อนไข'); }
                } else if (chosenOption === 2) {
                    let validTargets = pState.deck.filter(c => (c.type || '').toLowerCase() === 'avatar' && (c.cost || 0) <= 5 && !(c.special || "").toLowerCase().includes('only'));
                    if (validTargets.length > 0) {
                        io.to(pState.id).emit('open-search-deck-modal', { cards: validTargets, destination: 'hand', maxSelect: 1, message: `เลือก Avatar Cost 5 หรือต่ำกว่า จาก Deck 1 ใบขึ้นมือ` });
                    } else { io.to(pState.id).emit('error-message', 'ไม่มีเป้าหมายใน Deck ที่ตรงเงื่อนไข'); }
                }
            }
        }

        // จัดการส่ง Magic ลง Hell Zone หลังแสดงผล
        let isMagicCard = targetCard && ((targetCard.type || '').toLowerCase() === 'magic' || targetCard.magicSubtype);
        if (isMagicCard) {
            setTimeout(() => {
                let latestPState = rooms[roomName]?.players[playerRole];
                if (latestPState) {
                    let magicIdx = latestPState.board.magicZone.findIndex(c => c.uniqueId === cardId || c.id === cardId);
                    if (magicIdx !== -1) {
                        let playedMagic = latestPState.board.magicZone.splice(magicIdx, 1)[0];
                        latestPState.board.hellZone.push(playedMagic);
                        console.log(`🪦 [Magic Choice Complete] การ์ดเวทมนตร์ [${playedMagic.name}] ลงนรก`);
                        broadcastGameState(roomName, rooms[roomName]);
                    }
                }
            }, 3000); 
        }

        broadcastGameState(roomName, game);
        resolveNextEffect(game, roomName);
    });

    // 🔗 ระบบรับคำสั่งประกาศเข้าสู่สถานะคู่หู (ตามกฎ Official)
    socket.on('declare-partner-link', ({ roomName, playerRole, cardId }) => {
        let game = rooms[roomName];
        if (!game || game.activePlayer !== playerRole) return;

        let pState = game.players[playerRole];
        
        // 🛑 กฎ: ทำได้เทิร์นละ 1 ครั้งเท่านั้น
        if (pState.hasDeclaredLinkThisTurn) {
            return socket.emit('error-message', '❌ คุณประกาศเข้าสถานะคู่หูไปแล้วในเทิร์นนี้ (ทำได้เทิร์นละ 1 ครั้ง)');
        }

        let avatar = pState.board.avatarZone.find(c => c.uniqueId === cardId);
        if (!avatar || !avatar.partnerNameStr) return;

        // ค้นหาคู่หูบนสนามที่ยังไม่ได้ลิงก์
        let partnerCard = pState.board.avatarZone.find(a => 
            a.uniqueId !== avatar.uniqueId && a.name.includes(avatar.partnerNameStr) && !a.isLinkedStatus
        );

        if (!partnerCard) {
            return socket.emit('error-message', `❌ ไม่พบ [${avatar.partnerNameStr}] ที่พร้อมเข้าคู่หู บนสนามของคุณ!`);
        }

        // 🔗 ดำเนินการจับลิงก์ให้ทั้งสองใบ
        avatar.isLinkedStatus = true;
        partnerCard.isLinkedStatus = true;
        pState.hasDeclaredLinkThisTurn = true; // บันทึกโควตาการใช้ในเทิร์นนี้

        addGameLog(game, `🔗 ${playerRole} ประกาศให้ [${avatar.name}] และ [${partnerCard.name}] เข้าสู่สถานะคู่หูแล้ว!`);
        
        // 🤖 แจ้งเตือน Auto-Trigger Engine เผื่อมีความสามารถ "เมื่อเข้าสู่สถานะคู่หู" ทำงาน
        triggerAutoAbilities(game, roomName, 'EVENT_ENTER_LINK', { targetId: avatar.uniqueId });
        triggerAutoAbilities(game, roomName, 'EVENT_ENTER_LINK', { targetId: partnerCard.uniqueId });

        broadcastGameState(roomName, game);
    });

    // -------------------------------------------------------------------------
    // ระบบใช้การ์ด Magic (ใช้ Magic Engine)
    // -------------------------------------------------------------------------
    socket.on('play-magic-card', ({ roomName, playerRole, cardId, targetAvatarId }) => {
        let game = rooms[roomName];
        if (!game || game.activePlayer !== playerRole) return;

        // 🛑 [เพิ่มบรรทัดนี้] ล็อคไม่ให้ใช้เวทย์แทรกถ้าระบบติดพันอยู่
        if (isGameBusy(game)) {
            return socket.emit('error-message', '⏳ กรุณารอให้อีกฝ่ายตัดสินใจ หรือรอระบบประมวลผลให้เสร็จก่อน!');
        }

        let pState = game.players[playerRole];
        let cardIndex = pState.hand.findIndex(c => c.id === cardId || c.uniqueId === cardId);
        if (cardIndex === -1) return;

        let magicCardCheck = pState.hand[cardIndex];
        let originalCardInfo = cardDatabase.find(c => c.id === magicCardCheck.id) || magicCardCheck;

        // ให้ Engine จัดการหักการ์ด และเช็คโควต้า 
        let success = playMagicCard(game, playerRole, cardIndex, targetAvatarId, io, socket, roomName, originalCardInfo);
        
        if (success) {
            logTurnEvent(game, 'PLAY_MAGIC', { 
                playerRole: playerRole, 
                cardName: magicCardCheck.name,
                magicType: magicCardCheck.magicSubtype
            });
            addGameLog(game, `${playerRole} ประกาศใช้เวทมนตร์ [${magicCardCheck.name}]`);

            if (game.pendingAction) {
                // ⚡ โยนเข้า React Chain Engine
                initReactionWindow(game, roomName, playerRole, 'PLAY_MAGIC', game.pendingAction, `ฝ่ายตรงข้ามร่ายเวทย์ [${magicCardCheck.name}]`);
                game.pendingAction = null; 
            }

            broadcastGameState(roomName, game);
        }
    });

    // -------------------------------------------------------------------------
    // ⚔️ ระบบการต่อสู้ (อัปเดตระบบ โล่มนุษย์, ลูกฮึด, เตะไข่)
    // -------------------------------------------------------------------------
    socket.on('resolve-combat', ({ roomName, attackerPlayer, attackerId, defenderPlayer, targetType, targetId }) => {
        let game = rooms[roomName];
        if (!game || game.activePlayer !== attackerPlayer) return;

        // 🛑 [เพิ่มบรรทัดนี้] ล็อคไม่ให้สั่งโจมตีรัวๆ ถ้าระบบติดพันอยู่
        if (isGameBusy(game)) {
            return socket.emit('error-message', '⏳ กรุณารอให้อีกฝ่ายตัดสินใจ หรือรอระบบประมวลผลให้เสร็จก่อน!');
        }

        if (game.currentPhase !== 'BATTLE_PHASE') {
            socket.emit('error-message', 'สามารถต่อสู้ได้เฉพาะในช่วง Battle Phase เท่านั้น!');
            return;
        }

        let attackerState = game.players[attackerPlayer];
        let defenderState = game.players[defenderPlayer];

        let attackerIndex = attackerState.board.avatarZone.findIndex(a => a.uniqueId === attackerId || a.id === attackerId);
        if (attackerIndex === -1) return;
        let attackerCard = attackerState.board.avatarZone[attackerIndex];

        if (attackerCard.isResting) {
            socket.emit('error-message', 'Avatar นี้อยู่ในสภาพนอนแล้ว ไม่สามารถสั่งโจมตีได้');
            return;
        }

        // เปลี่ยน Avatar เป็นสภาพนอนหลังโจมตี
        attackerCard.isResting = true;
        addGameLog(game, `⚔️ ${attackerPlayer} สั่ง [${attackerCard.name}] โจมตี!`);

        triggerAutoAbilities(game, roomName, 'EVENT_ATTACK_DECLARED', { 
            attackerId: attackerCard.uniqueId,
            attackerName: attackerCard.name 
        });

        // เก็บข้อมูลการต่อสู้รอไว้ก่อน
        game.pendingCombat = { attackerPlayer, attackerId, defenderPlayer, targetType, targetId };

        // 🧠 1. ระบบดักจับ "อัตโนมัติ เมื่อโจมตี" (Auto-Attack Engine)
        let isReactLocked = false;
        let effectiveAttackerText = getEffectiveAbilityText(attackerState, attackerCard).toLowerCase();

        // เช็คเคส: นางอัปสร (ห้ามใช้ React)
        if (effectiveAttackerText.includes('ไม่สามารถสั่งใช้งาน react magic')) {
            isReactLocked = true;
            addGameLog(game, `🚫 [${attackerCard.name}] ปิดผนึกการใช้งาน React Magic ของฝ่ายตรงข้าม!`);
        }
        
        // ⚡ 2. โยนเข้า React Engine
        if (!isReactLocked) {
            initReactionWindow(game, roomName, attackerPlayer, 'ATTACK_DECLARED', { type: 'COMBAT_REACT' }, `ฝ่ายตรงข้ามสั่ง [${attackerCard.name}] โจมตี!`);
            broadcastGameState(roomName, game);
        } else {
            // ถ้าโดนนางอัปสรล็อคเวทย์ ข้ามไปเช็คโล่มนุษย์และตีเลย
            checkHumanShieldAndExecute(game, roomName);
        }

        // 3. ถ้าไม่มี React หรือโดนล็อค React ไว้ ให้ไปสู่ขั้นตอน โล่มนุษย์ ทันที
        if (!isPaused) {
            checkHumanShieldAndExecute(game, roomName);
        } else {
            broadcastGameState(roomName, game); // อัปเดตหน้าจอเพื่อรอคำตอบ
        }
    });

    // 🛡️ ฟังก์ชันตรวจสอบโล่มนุษย์ก่อนเข้าสู่การคำนวณดาเมจ
    function checkHumanShieldAndExecute(game, roomName) {
        let combatData = game.pendingCombat;
        if (!combatData) return;

        let defenderState = game.players[combatData.defenderPlayer];

        let availableShields = defenderState.board.avatarZone.filter(a => {
            if (a.isResting) return false;
            let effectiveText = getEffectiveAbilityText(defenderState, a).toLowerCase();
            return effectiveText.includes('โล่มนุษย์');
        });

        if (availableShields.length > 0) {
            // ถ้ามีโล่มนุษย์ ให้หยุดรอถามฝ่ายป้องกัน
            game.pendingTargetAction = { effectType: 'HUMAN_SHIELD' };
            io.to(defenderState.id).emit('request-target', {
                message: `⚠️ ถูกโจมตี! เลือก Avatar 'โล่มนุษย์' 1 ใบรับดาเมจแทน หรือกดยกเลิกปล่อยผ่าน`,
                validTargets: availableShields,
                maxSelect: 1,
                context: 'HUMAN_SHIELD'
            });
            broadcastGameState(roomName, game);
        } else {
            // ถ้าไม่มีโล่มนุษย์ เข้าสู่การคำนวณความเสียหาย
            executeCombatPhase(game, roomName);
        }
    }

    // 💥 ฟังก์ชันดำเนินการต่อสู้ให้จบ (ถูกแยกออกมาเพื่อให้รอโล่มนุษย์ได้)
    function executeCombatPhase(game, roomName) {
        let combatData = game.pendingCombat;
        if (!combatData) return;

        let { attackerPlayer, attackerId, defenderPlayer, targetType, targetId } = combatData;
        let attackerState = game.players[attackerPlayer];
        let defenderState = game.players[defenderPlayer];

        let attackerIndex = attackerState.board.avatarZone.findIndex(a => a.uniqueId === attackerId || a.id === attackerId);
        if (attackerIndex === -1) return;
        let attackerCard = attackerState.board.avatarZone[attackerIndex];

        queueEffect(game, roomName, attackerPlayer, attackerCard, 'ON_ATTACK');

        // 🎯 โจมตีเข้า LIFE Card Zone
        if (targetType === 'lifeZone') {
            // กฎ เตะไข่: ถ้าอีกฝ่ายมี Avatar ยืนบังอยู่ แต่คนตีไม่มี เตะไข่ จะตีไม่เข้า
            let hasTaunt = defenderState.board.avatarZone.length > 0;
            
            // 🟢 ดึง Text ที่ผ่านการกรองแล้วมาเช็คคีย์เวิร์ด "เตะไข่" (รองรับระบบคู่หู)
            let effectiveAttackerText = getEffectiveAbilityText(attackerState, attackerCard).toLowerCase();
            let canTekKhai = effectiveAttackerText.includes('เตะไข่') || effectiveAttackerText.includes('เดะไข่');
            
            if (hasTaunt && !canTekKhai) {
                io.to(attackerState.id).emit('error-message', '❌ ตี LIFE ไม่ได้! อีกฝ่ายมี Avatar ยืนบังอยู่และคุณไม่มีคีย์เวิร์ด เตะไข่');
                game.pendingCombat = null;
                broadcastGameState(roomName, game);
                return;
            }

            console.log(`⚔️ [Battle] ${attackerPlayer} สั่ง [${attackerCard.name}] โจมตีใส่ LIFE ของ ${defenderPlayer}!`);
            let power = attackerCard.currentPower !== undefined ? attackerCard.currentPower : (attackerCard.basePower || 0);
            
            if (power > 0) {
                if (defenderState.isCritical) {
                    triggerGameOver(game, roomName, attackerPlayer, `โจมตีใส่ LIFE สำเร็จ ในขณะที่อีกฝ่ายอยู่ในสถานะสาหัส!`);
                    return;
                }
                
                if (defenderState.lifeZone && defenderState.lifeZone.length > 0) {
                    let unrevealedIndex = defenderState.lifeZone.findIndex(l => !l.isRevealed);
                    if (unrevealedIndex !== -1) {
                        // ดึงตัวแปรการ์ด LIFE ออกมาใช้
                        let revealedLife = defenderState.lifeZone[unrevealedIndex];
                        revealedLife.isRevealed = true;
                        
                        addGameLog(game, `💥 [LIFE Reveal] หงาย LIFE Card: [${revealedLife.name}]`);
                        
                        // 🟢 สั่งให้ความสามารถ LIFE ทำงาน
                        processLifeCardEffect(game, roomName, defenderPlayer, revealedLife);
                        
                        let remainingHidden = defenderState.lifeZone.filter(l => !l.isRevealed).length;
                        if (remainingHidden === 0) {
                            defenderState.isCritical = true;
                            addGameLog(game, `⚠️ ${defenderPlayer} เข้าสู่สถานะ "สาหัส"!`);
                        }
                    }
                }
            }
            attackerCard.tempCombatPower = 0;
            game.pendingCombat = null;
            broadcastGameState(roomName, game);
            return;
        }

        // 🎯 โจมตี Avatar
        if (targetType === 'avatar') {
            let defenderIndex = defenderState.board.avatarZone.findIndex(a => a.uniqueId === targetId || a.id === targetId);
            if (defenderIndex === -1) { game.pendingCombat = null; broadcastGameState(roomName, game); return; }
            let defenderCard = defenderState.board.avatarZone[defenderIndex];

            queueEffect(game, roomName, attackerPlayer, attackerCard, 'ON_COMBAT');
            queueEffect(game, roomName, defenderPlayer, defenderCard, 'ON_COMBAT');

            let attPower = attackerCard.currentPower || 0;
            let defPower = defenderCard.currentPower || 0;

            // 🟢 👉 ตรวจสอบกฎ "ลูกฮึด" โดยอิงจาก Text ที่ผ่านการเช็คคู่หูแล้ว
            let effectiveAttackerText = getEffectiveAbilityText(attackerState, attackerCard).toLowerCase();
            let effectiveDefenderText = getEffectiveAbilityText(defenderState, defenderCard).toLowerCase();

            let attHasGrit = effectiveAttackerText.includes('ลูกฮึด');
            let defHasGrit = effectiveDefenderText.includes('ลูกฮึด');

            if (attPower > defPower || (attPower === defPower && attHasGrit && !defHasGrit)) {
                logTurnEvent(game, 'COMBAT_DESTROY', { 
                    playerRole: attackerPlayer, 
                    sourceName: attackerCard.name,
                    targetName: defenderCard.name
                });
                // โจมตีชนะ (หรือพลังเท่ากันแต่เรามีลูกฮึดฝั่งเดียว)
                removeAvatarWithEquipments(game, roomName, defenderPlayer, defenderIndex);
                queueEffect(game, roomName, attackerPlayer, attackerCard, 'ON_DESTROY_OPPONENT_AVATAR');
                addGameLog(game, `💥 [${attackerCard.name}] โจมตีชนะ! ทำลาย [${defenderCard.name}] ลงนรก`);
                
            } else if (defPower > attPower || (attPower === defPower && defHasGrit && !attHasGrit)) {
                // ป้องกันชนะ (หรือพลังเท่ากันแต่อีกฝ่ายมีลูกฮึดฝั่งเดียว)
                removeAvatarWithEquipments(game, roomName, attackerPlayer, attackerIndex);
                queueEffect(game, roomName, defenderPlayer, defenderCard, 'ON_DESTROY_OPPONENT_AVATAR');
                addGameLog(game, `🛡️ [${defenderCard.name}] ป้องกันสำเร็จ! ทำลาย [${attackerCard.name}] ลงนรก`);
                
            } else {
                // พลังเท่ากัน และไม่มีลูกฮึด (หรือมีทั้งคู่) -> ตายคู่
                removeAvatarWithEquipments(game, roomName, attackerPlayer, attackerIndex);
                removeAvatarWithEquipments(game, roomName, defenderPlayer, defenderIndex);
                addGameLog(game, `⚔️ พลังเท่ากัน! [${attackerCard.name}] และ [${defenderCard.name}] ถูกทำลายทั้งคู่`);
            }

            attackerCard.tempCombatPower = 0;
            defenderCard.tempCombatPower = 0;
            game.pendingCombat = null;

            broadcastGameState(roomName, game);
        }
    }

    // 👁️ [วางแทนที่อันเก่าใน server.js] ฟังก์ชันและ Event Listener สำหรับระบบสอดแนมขั้นสูง
    function triggerAdvancedScout(game, playerRole, card, io, socketId) {
        let pState = game.players[playerRole];
        if (!pState || !pState.deck || pState.deck.length === 0) return;

        let scoutAction = null;
        if (card.structuredAbilities) {
            for (let abi of card.structuredAbilities) {
                let foundAction = abi.effect.actions.find(act => act.type === 'ADVANCED_SCOUT');
                if (foundAction) { scoutAction = foundAction; break; }
            }
        }

        let scoutAmount = scoutAction ? scoutAction.scoutAmount : 3;
        let pickAmount = scoutAction ? scoutAction.pickAmount : 1;
        let destination = scoutAction ? scoutAction.remainingDestination : 'DECK_BOTTOM';

        let actualCount = Math.min(scoutAmount, pState.deck.length);
        let scoutedCards = [];
        for (let i = 0; i < actualCount; i++) {
            scoutedCards.push(pState.deck.pop());
        }

        // บันทึกข้อมูลการสอดแนมชั่วคราวรอไว้
        game.pendingScoutData = {
            playerRole: playerRole,
            scoutedCards: scoutedCards,
            pickAmount: pickAmount,
            destination: destination
        };

        // ส่งข้อมูลไปเปิด Modal ที่หน้าจอผู้เล่น (ใช้ Event เดิม 'open-scout-modal' ที่หน้าเว็บรอรับอยู่)[cite: 6]
        io.to(socketId).emit('open-scout-modal', {
            scoutedCards: scoutedCards,
            maxSelect: pickAmount,
            message: `👁️ สอดแนม ${actualCount} ใบ: เลือกการ์ดขึ้นมือ ${pickAmount} ใบ`
        });
    }

    // 👁️ [แทนที่ของเดิม] รับผลการเลือกสอดแนมจากหน้าเว็บ
    socket.on('submit-scout-choice', ({ roomName, playerRole, chosenCardIds, remainingCards }) => {
        let game = rooms[roomName];
        if (!game || !game.players[playerRole]) return;

        let pState = game.players[playerRole];
        let scoutData = game.pendingScoutData;
        let destination = scoutData ? scoutData.destination : 'DECK_BOTTOM';

        if (scoutData && scoutData.scoutedCards) {
            let pickedCards = [];
            let leftCards = [];

            // คัดแยกการ์ดที่ผู้เล่นเลือก (ขึ้นมือ) กับการ์ดที่เหลือ
            scoutData.scoutedCards.forEach(card => {
                if (chosenCardIds.includes(card.id) || chosenCardIds.includes(card.uniqueId)) {
                    pickedCards.push(card);
                } else {
                    leftCards.push(card);
                }
            });

            // นำการ์ดที่เลือกใส่ขึ้นมือ
            pickedCards.forEach(card => pState.hand.push(card));

            // จัดการการ์ดที่เหลือตามปลายทางที่กำหนดในการ์ดใบนั้นๆ
            if (destination === 'HELL_ZONE') {
                leftCards.forEach(card => pState.board.hellZone.push(card));
                addGameLog(game, `👁️ [Scout] นำการ์ดที่เหลือ ${leftCards.length} ใบลงนรก`);
            } else if (destination === 'DECK_TOP') {
                leftCards.reverse().forEach(card => pState.deck.push(card));
                addGameLog(game, `👁️ [Scout] นำการ์ดที่เหลือ ${leftCards.length} ใบไว้บนสุดของ Deck`);
            } else {
                // ค่าเริ่มต้น: คืนใต้เด็คแล้วสับกองตามกฎ[cite: 6]
                leftCards.forEach(card => pState.deck.unshift(card));
                pState.deck = shuffleDeck(pState.deck);
                addGameLog(game, `👁️ [Scout] นำการ์ดที่เหลือคืนใต้ Deck และสับกองเรียบร้อย`);
            }

            game.pendingScoutData = null;
        } else {
            // Fallback กรณีเรียกใช้แบบปกติ
            chosenCardIds.forEach(cId => {
                let cardIndex = remainingCards.findIndex(c => c.id === cId);
                if (cardIndex !== -1) {
                    let pickedCard = remainingCards.splice(cardIndex, 1)[0];
                    pState.hand.push(pickedCard);
                }
            });
            remainingCards.forEach(card => pState.deck.push(card));
            pState.deck = shuffleDeck(pState.deck);
        }

        broadcastGameState(roomName, game);
        resolveNextEffect(game, roomName);
    });

    // 🧠 Router แยกสายความสามารถของ "ร่างอวตารพระนารายณ์" แต่ละปาง
    function handleNarayanAvatarBonus(game, playerRole, summonedCard, io, socketId) {
        let pState = game.players[playerRole];
        let oppRole = playerRole === 'playerA' ? 'playerB' : 'playerA';
        let oppState = game.players[oppRole];

        let cardName = summonedCard.name || "";

        // 1️⃣ ปาง: เทพผดุงธรรม (สอดแนม 2 ใบขึ้นมือ -> เนรเทศศัตรู)
        if (cardName.includes('เทพผดุงธรรม')) {
            let totalScoutCost = 0;
            let scoutedCount = 0;
            for (let i = 0; i < 2; i++) {
                if (pState.deck.length > 0) {
                    let drawnCard = pState.deck.pop();
                    pState.hand.push(drawnCard);
                    totalScoutCost += (drawnCard.cost || 0);
                    scoutedCount++;
                }
            }
            addGameLog(game, `👁️ [สอดแนม] ได้การ์ด ${scoutedCount} ใบขึ้นมือ (Cost รวม: ${totalScoutCost})`);

            let banishTargets = oppState.board.avatarZone.filter(c => (c.cost || 0) <= totalScoutCost);
            if (banishTargets.length > 0) {
                game.pendingTargetAction = { effectType: 'BANISH_OPPONENT_AVATAR', playerRole: playerRole };
                io.to(socketId).emit('request-target', {
                    message: `🌌 เลือก Avatar อีกฝ่าย 1 ใบ (Cost ไม่เกิน ${totalScoutCost}) เพื่อเนรเทศ!`,
                    validTargets: banishTargets, maxSelect: 1, context: 'BANISH_OPPONENT_AVATAR'
                });
            }
        } 
    
        // 2️⃣ ปาง: นรสิงห์ (ทำลายศัตรู Cost ไม่เกิน 4)
        else if (cardName.includes('นรสิงห์')) {
            summonedCard.narayanEndPhaseSwap = true; // แปะป้ายบอกระบบว่าตัวนี้ต้องสลับร่างตอนจบเทิร์น!
        
            let destroyTargets = oppState.board.avatarZone.filter(c => (c.cost || 0) <= 4);
            if (destroyTargets.length > 0) {
                game.pendingTargetAction = { effectType: 'DESTROY_OPPONENT_AVATAR', playerRole: playerRole };
                io.to(socketId).emit('request-target', {
                    message: `💥 เลือก Avatar อีกฝ่าย 1 ใบ (Cost ไม่เกิน 4) เพื่อทำลาย!`,
                    validTargets: destroyTargets, maxSelect: 1, context: 'DESTROY_OPPONENT_AVATAR'
                });
            }
        } 
    
        // 3️⃣ ปาง: เกษียรสมุทร (ปลุก Avatar เผ่าเทพที่นอนอยู่ให้ตื่น)
        else if (cardName.includes('เกษียรสมุทร')) {
            summonedCard.narayanEndPhaseSwap = true; // แปะป้ายสลับร่างตอนจบเทิร์น
        
            let wakeTargets = pState.board.avatarZone.filter(c => c.isResting && (c.symbol || "").includes('เทพ'));
            if (wakeTargets.length > 0) {
                game.pendingTargetAction = { effectType: 'WAKE_UP_AVATAR', playerRole: playerRole };
                io.to(socketId).emit('request-target', {
                    message: `🔆 เลือก Avatar {เทพ} 1 ใบที่อยู่ในสภาพนอน เพื่อเปลี่ยนเป็นสภาพตื่น!`,
                    validTargets: wakeTargets, maxSelect: 1, context: 'WAKE_UP_AVATAR'
                });
            }
        }
    }

    // ⚡ ระบบรับข้อมูลเมื่อผู้เล่นกด "ใช้การ์ดตอบโต้" หรือ "ไม่ตอบโต้"
    socket.on('submit-reaction', ({ roomName, playerRole, reactCardId }) => {
        let game = rooms[roomName];
        if (!game || !game.reactionContext || game.reactionWaitingFor !== playerRole) return;

        let pState = game.players[playerRole];

        if (reactCardId) {
            let cardIndex = pState.hand.findIndex(c => c.id === reactCardId || c.uniqueId === reactCardId);
            if (cardIndex !== -1) {
                let reactCard = pState.hand.splice(cardIndex, 1)[0];
                
                pState.board.magicZone.push(reactCard);
                addGameLog(game, `⚡ ${playerRole} ใช้ React Magic [${reactCard.name}]!`);
                
                // ยัดลง Chain Stack!
                game.reactionChain.push({ playerRole: playerRole, card: reactCard, isCancelled: false });

                // สำคัญ! รีเซ็ต Pass Count กลับเป็น 0 เพราะมีการต่อคิวใหม่ และโยนสิทธิ์กลับไปถามอีกฝ่ายทันที
                game.reactionContext.passCount = 0;
                let nextPlayerRole = playerRole === 'playerA' ? 'playerB' : 'playerA';
                
                broadcastGameState(roomName, game);
                checkAndPromptReaction(game, roomName, nextPlayerRole);
            }
        } else {
            console.log(`⏩ [React Window] ${playerRole} เลือกไม่ตอบโต้ (Pass)`);
            addGameLog(game, `⏩ ${playerRole} ปล่อยผ่านสิทธิ์`);
            handleReactionPass(game, roomName, playerRole);
        }
    });

    // 🛑 ฟังก์ชันตัวกลางสำหรับรันคำสั่งที่ถูกหยุดรอไว้ 
    function executePendingAction(roomName, gameObj = null, context = null) {
        let game = gameObj || rooms[roomName];
        if (!game || !context) return;

        let actionType = context.eventType;
        let eventData = context.eventData;
        let originalPlayerRole = context.originalPlayer;

        // ล้างบริบททิ้งก่อนดำเนินการ
        game.reactionContext = null;
        game.reactionChain = [];

        // 👉 กรณีเป็นเวทมนตร์ค้างไว้
        if (actionType === 'PLAY_MAGIC') {
            resolvePendingMagic(game, eventData, roomName, io, broadcastGameState);
            triggerAutoAbilities(game, roomName, 'EVENT_MAGIC_PLAYED', { 
                magicName: eventData.magicCard.name,
                magicSymbol: eventData.magicCard.symbol || '',
                magicSubtype: eventData.magicCard.magicSubtype || ''
            });
        }
        
        // 👉 กรณีเป็นการอัญเชิญ Avatar
        else if (actionType === 'SUMMON_AVATAR') {
            let pState = game.players[originalPlayerRole];
            
            pState.board.avatarZone.push(eventData.summonedCard);
            addGameLog(game, `✨ ${originalPlayerRole} อัญเชิญ [${eventData.summonedCard.name}] ลงสนามสำเร็จ!`);
            
            queueEffect(game, roomName, originalPlayerRole, eventData.summonedCard, 'ON_SUMMON');
            
            let abilityText = (eventData.summonedCard.abilityText || "").toLowerCase();
            if (abilityText.includes('สอดแนม') || abilityText.includes('สอดเเนม')) {
                let match = abilityText.match(/สอดเ?น?ม\s*(\d+)/);
                let scoutNum = match ? parseInt(match[1]) : 3; 
                let scoutedCards = handleScoutAbility(game, originalPlayerRole, scoutNum);
                if (scoutedCards.length > 0) io.to(pState.id).emit('open-scout-modal', { scoutedCards });
            }

            if (abilityText.includes('เลือกปฏิบัติ')) {
                let options = extractChoiceOptions(eventData.summonedCard.abilityText);
                io.to(pState.id).emit('open-choice-modal', {
                    cardName: eventData.summonedCard.name,
                    options: options,
                    cardId: eventData.summonedCard.uniqueId || eventData.summonedCard.id
                });
            }
        }

        // 👉 กรณีต่อสู้
        else if (actionType === 'ATTACK_DECLARED') {
            checkHumanShieldAndExecute(game, roomName);
        }

        broadcastGameState(roomName, game);
        resolveNextEffect(game, roomName);
    }

    // -------------------------------------------------------------------------
    // 4. ระบบจั่วการ์ด (อ้างอิงกฎ Draw Phase: น้อยกว่า 3 ใบจั่วให้ครบ 3 ใบ, >= 3 ใบจั่ว 1 ใบ)
    // -------------------------------------------------------------------------
    socket.on('draw-card', ({ roomName, playerRole }) => {
        let game = rooms[roomName];
        if (!game) return;

        if (game.activePlayer !== playerRole) {
            console.log(`❌ [Draw ล้มเหลว] ไม่ใช่ตาของ ${playerRole}`);
            return;
        }

        let pState = game.players[playerRole];

        if (pState.hasDrawnThisTurn) {
            console.log(`❌ [Draw ล้มเหลว] ผู้เล่น ${playerRole} ได้ทำการจั่วการ์ดไปแล้วในเทิร์นนี้`);
            return;
        }

        if (pState && pState.deck && pState.deck.length > 0) {
            let handCount = pState.hand.length;
            let drawCount = 1;

            if (handCount < 3) {
                drawCount = 3 - handCount; 
            }

            for (let i = 0; i < drawCount; i++) {
                if (pState.deck.length > 0) {
                    pState.hand.push(pState.deck.pop());
                }
            }
            
            pState.hasDrawnThisTurn = true;
            addGameLog(game, `${playerRole} จั่วการ์ด ${drawCount} ใบ`);
            
            // ♻️ เปลี่ยนเป็น Main Phase อัตโนมัติหลังจากจั่วเสร็จ
            game.currentPhase = 'MAIN_PHASE';
            console.log(`⏩ [Phase] ผู้เล่น ${playerRole} จั่วการ์ดเสร็จสิ้น เข้าสู่ MAIN PHASE อัตโนมัติ`);

            // 🟢 ย้ายโค้ดแจกโบนัส LIFE Card มาไว้ตรงนี้แทน! (ตอนเข้า MAIN PHASE)
            if (pState.pendingLifeDraws > 0) {
                for(let i = 0; i < pState.pendingLifeDraws; i++) {
                    if (pState.deck.length > 0) {
                        pState.hand.push(pState.deck.pop());
                    }
                }
                addGameLog(game, `✨ [LIFE Bonus] ${playerRole} ได้จั่วการ์ดโบนัส ${pState.pendingLifeDraws} ใบ จากผลของ LIFE Card!`);
                pState.pendingLifeDraws = 0; // เคลียร์สถานะ
            }

            broadcastGameState(roomName, game);
        } else {
            console.log(`⚠️ [Draw] เด็คของผู้เล่น ${playerRole} หมดแล้ว!`);
        }
    });

    // -------------------------------------------------------------------------
    // 5. ระบบจบเทิร์น (สลับฝั่ง, เช็คทิ้งการ์ด และปลุกการ์ดฝั่งที่เริ่มเทิร์นใหม่)
    // -------------------------------------------------------------------------
    // =========================================================================
    // 🔄 ฟังก์ชันศูนย์กลางจัดการการเปลี่ยนเทิร์นและการสแกน End Phase อัตโนมัติ
    // =========================================================================
    
    // ฟังก์ชันเช็คว่าบนสนามมีการ์ดที่ระบุถึง End Phase ไหม?
    function checkAndEnterEndPhase(game, playerRole, roomName) {
        clearTemporaryEffects(game, 'END_PHASE');
        executePhaseTriggers(game, roomName, 'END_PHASE');
        triggerAutoAbilities(game, roomName, 'EVENT_END_PHASE', { 
            activePlayer: playerRole 
        });

        let pState = game.players[playerRole];
        let hasEndPhaseAbility = false;

        // รวมการ์ดทุกใบของฝั่งเราที่อยู่บนสนามเพื่อตรวจหา Keyword
        let allBoardCards = [
            ...(pState.board.avatarZone || []),
            ...(pState.board.magicZone || []),
            ...(pState.board.constructZone || [])
        ];
        if (game.landMagicZone && game.landMagicZone.card) {
            allBoardCards.push(game.landMagicZone.card);
        }

        // สแกนหาคำว่า End Phase หรือ จบเทิร์น
        for (let card of allBoardCards) {
            let text = (card.abilityText || "").toLowerCase();
            if (text.includes('end phase') || text.includes('ช่วงจบเทิร์น') || text.includes('เมื่อจบเทิร์น')) {
                hasEndPhaseAbility = true;
                break;
            }
        }

        // ถ้ามีการ์ดที่ต้องสั่งใช้ใน End Phase ให้รอผู้เล่นกด
        if (hasEndPhaseAbility) {
            game.currentPhase = 'END_PHASE';
            console.log(`⏩ [Phase] ผู้เล่น ${playerRole} เข้าสู่ END PHASE (รอผู้เล่นใช้งานการ์ด)`);
            broadcastGameState(roomName, game);
        } 
        // ถ้าไม่มีการ์ดที่ใช้งานได้ ให้ข้ามไปขั้นตอนเช็คทิ้งการ์ดและจบเทิร์นทันที!
        else {
            console.log(`⏩ [Phase] ไม่มีเอฟเฟกต์ End Phase ข้ามไปตรวจการ์ดเกิน 7 ใบอัตโนมัติ`);
            executeEndTurn(game, playerRole, roomName);
        }
    }

    // ฟังก์ชันเริ่มกระบวนการจบเทิร์น (เช็คการ์ดมือเกิน 7 ใบ)
    function executeEndTurn(game, playerRole, roomName) {
        let pState = game.players[playerRole];

        if (pState.hand.length > 7 && !pState.isDiscarding) {
            pState.isDiscarding = true;
            console.log(`⚠️ [End Turn] ผู้เล่น ${playerRole} มีการ์ดบนมือ ${pState.hand.length} ใบ ต้องเลือกทิ้งการ์ดก่อน`);
            io.to(pState.id).emit('request-discard', { excessCount: pState.hand.length - 7 });
            broadcastGameState(roomName, game);
            return; // หยุดรอให้เขาทิ้งการ์ดเสร็จก่อน
        }

        // ถ้าไม่ต้องทิ้งการ์ด หรือทิ้งเสร็จแล้ว ให้เปลี่ยนเทิร์น
        finalizeTurnTransition(game, roomName);
    }

    // ฟังก์ชันจบเทิร์นสมบูรณ์ สลับฝั่งและรีเซ็ตค่าต่างๆ
    function finalizeTurnTransition(game, roomName) {
        clearTemporaryEffects(game, 'END_TURN');
        game.activePlayer = (game.activePlayer === 'playerA') ? 'playerB' : 'playerA';
        game.magicUsage = {}; 
        game.turnHistory = [];
        game.currentPhase = 'DRAW_PHASE'; // เริ่มที่ Draw Phase ฝั่งตรงข้าม
        clearTemporaryEffects(game, 'DRAW_PHASE', game.activePlayer);

        // นับเทิร์นเมื่อสลับกลับมาที่ผู้เล่นที่ 1
        if (game.activePlayer === game.firstPlayer) {
            game.turnCount = (game.turnCount || 1) + 1;
            console.log(`🔄 [รอบวงครบ] เลื่อนขึ้นเป็น [เทิร์นที่ ${game.turnCount}]`);
        } else {
            console.log(`🔄 [เปลี่ยนเทิร์น] ตาของผู้เล่น ${game.activePlayer}`);
        }

        let nextState = game.players[game.activePlayer];
        if (nextState) {
            nextState.hasDrawnThisTurn = false;
            nextState.hasDeclaredLinkThisTurn = false;
            // ปลุก Avatar ฝั่งตรงข้ามให้ตื่นรอไว้เลย
            if (nextState.board && nextState.board.avatarZone) {
                nextState.board.avatarZone.forEach(a => a.isResting = false);
            }
        }
        broadcastGameState(roomName, game);
    }

    // -------------------------------------------------------------------------
    // 🔗 Socket Listeners ที่เรียกใช้งานฟังก์ชันด้านบน
    // -------------------------------------------------------------------------
    
    socket.on('change-phase', ({ roomName, playerRole }) => {
        let game = rooms[roomName];
        if (!game || game.activePlayer !== playerRole) return;

        if (game.currentPhase === 'DRAW_PHASE') {
            game.currentPhase = 'MAIN_PHASE';
            addGameLog(game, `--- ${playerRole} เข้าสู่ MAIN PHASE ---`);
        
            broadcastGameState(roomName, game);
        } else if (game.currentPhase === 'MAIN_PHASE') {
            if (game.turnCount === 1 && game.activePlayer === game.firstPlayer) {
                // ข้าม Battle Phase ของเทิร์น 1 ฝ่ายแรก ไปเช็ค End Phase ทันที
                addGameLog(game, `--- ข้าม BATTLE PHASE ในเทิร์นแรก ---`);
                checkAndEnterEndPhase(game, playerRole, roomName);
            } else {
                game.currentPhase = 'BATTLE_PHASE';
                addGameLog(game, `--- ${playerRole} เข้าสู่ BATTLE PHASE ---`);
                executePhaseTriggers(game, roomName, 'BATTLE_PHASE');
                broadcastGameState(roomName, game);
            }
        } else if (game.currentPhase === 'BATTLE_PHASE') {
            // เมื่อกดออกจาก Battle Phase ให้ไปเช็ค End Phase อัตโนมัติ
            checkAndEnterEndPhase(game, playerRole, roomName);
        }
    });

    socket.on('end-turn', ({ roomName, playerRole }) => {
        let game = rooms[roomName];
        if (!game || game.activePlayer !== playerRole) return;
        executeEndTurn(game, playerRole, roomName);
    });

    socket.on('submit-discard', ({ roomName, playerRole, discardedCardIds }) => {
        let game = rooms[roomName];
        if (!game || game.activePlayer !== playerRole) return;

        let pState = game.players[playerRole];

        discardedCardIds.forEach(cardId => {
            let index = pState.hand.findIndex(c => c.id === cardId);
            if (index !== -1) {
                let discardedCard = pState.hand.splice(index, 1)[0];
                pState.board.hellZone.push(discardedCard);
            }
        });

        // เช็คว่าทิ้งครบตามจำนวนหรือยัง (เผื่อเขากดไม่ครบ)
        if (pState.hand.length > 7) {
            io.to(pState.id).emit('request-discard', { excessCount: pState.hand.length - 7 });
            broadcastGameState(roomName, game);
            return;
        }

        pState.isDiscarding = false;
        
        // ทิ้งการ์ดเสร็จแล้ว บังคับจบเทิร์นสมบูรณ์ทันที
        finalizeTurnTransition(game, roomName);
    });

});


const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server กำลังรันอยู่ที่พอร์ต http://localhost:${PORT}`);
});