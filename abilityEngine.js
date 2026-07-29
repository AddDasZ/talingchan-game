// ==========================================
// ศูนย์กลางระบบความสามารถการ์ด (Ability Engine)
// รองรับความสามารถ: จุติ, สอดแนม, ธรณีสูบ, เซ่นไหว้, สั่งใช้, คำสั่งเสีย, เนรเทศ, เลือกปฏิบัติ ฯลฯ
// เชื่อมต่อกับระบบ Universal Target Selection
// ==========================================

// 🛑 (ลบ import ที่ผิดพลาดด้านบนออกไปแล้ว)

export function processCardAbilities(game, playerRole, card, triggerType = 'ON_SUMMON', chosenOption = 1, isPhorDeeTriggered = false, io = null, socketId = null) {
    let pState = game.players[playerRole];
    let opponentRole = playerRole === 'playerA' ? 'playerB' : 'playerA';
    let oppState = game.players[opponentRole];
    let text = card.abilityText || "";

    console.log(`✨ [Ability Engine] กำลังประมวลผลการ์ด: [${card.name}] | Trigger: ${triggerType}`);

    // -------------------------------------------------------------------------
    // 0. ตรวจสอบเงื่อนไขความสามารถ "เทิร์นละครั้ง" (Turn-based Restriction)
    // -------------------------------------------------------------------------
    if (text.includes('เทิร์นละครั้ง') && !text.includes('อัตโนมัติ')) {
        if (!game.turnUsage) game.turnUsage = {};
        let usageKey = `${playerRole}_${card.id}_${card.name}`;
        let currentTurn = game.turnCount || 1;

        if (game.turnUsage[usageKey] === currentTurn) {
            console.log(`⏳ [Keyword: เทิร์นละครั้ง] การ์ด [${card.name}] ถูกใช้งานไปแล้วในเทิร์นนี้`);
            return;
        }
        game.turnUsage[usageKey] = currentTurn;
    }

    // -------------------------------------------------------------------------
    // 1. ความสามารถประเภท "จุติ" (ทำงานเมื่ออัญเชิญลงสนาม)
    // -------------------------------------------------------------------------
    if (text.includes('จุติ') && triggerType === 'ON_SUMMON') {
        
        // 🛑 A. กรณี "เซ่นไหว้" (ต้องทำลายการ์ดบน Avatar Zone ก่อน)
        if (text.includes('เซ่นไหว้')) {
            console.log(`💀 [Keyword: เซ่นไหว้] ตรวจพบเงื่อนไขเซ่นไหว้ของการ์ด [${card.name}]`);
            
            // ถ้ามี io และ socketId ให้เปิดหน้าต่างเลือก Avatar ของตัวเองเพื่อเซ่นไหว้
            if (io && socketId && pState.board.avatarZone.length > 0) {
                game.pendingTargetAction = {
                    effectType: 'SACRIFICE_AVATAR',
                    playerRole: playerRole,
                    cardId: card.id
                };
                io.to(socketId).emit('request-target', {
                    message: `เลือก Avatar บนสนามของคุณ 1 ใบเพื่อเซ่นไหว้สำหรับการ์ด [${card.name}]`,
                    validTargets: pState.board.avatarZone,
                    maxSelect: 1,
                    context: 'SACRIFICE_AVATAR'
                });
            } else if (pState.board.avatarZone.length > 0) {
                // กรณีไม่มี socket แต่อยากให้ทำงานอัตโนมัติ (หยิบตัวพอย้ายลงนรก)
                let sacrificedAvatar = pState.board.avatarZone.pop();
                pState.board.hellZone.push(sacrificedAvatar);
            }
        }

        // 🛑 B. กรณี "สอดแนม" (Scout)
        if (text.includes('สอดเเนม') || text.includes('สอดแนม')) {
            let match = text.match(/สอดเ?น?ม\s*(\d+)/);
            let scoutCount = match ? parseInt(match[1]) : 3;
            console.log(`👁️ [Keyword: สอดแนม] จำนวน ${scoutCount} ใบ`);
            
            let scoutedCards = handleScoutAbility(game, playerRole, scoutCount);
            if (scoutedCards.length > 0 && io && socketId) {
                io.to(socketId).emit('open-scout-modal', { scoutedCards });
            }
        }

        // 🛑 C. กรณี "ธรณีสูบ" (Mill)
        if (text.includes('ธรณีสูบ')) {
            let match = text.match(/ธรณีสูบ\s*(\d+)/);
            let thorCount = match ? parseInt(match[1]) : 1;
            console.log(`🌊 [Keyword: ธรณีสูบ] จำนวน ${thorCount} ใบ`);
            
            for (let i = 0; i < thorCount; i++) {
                if (pState.deck.length > 0) {
                    pState.board.hellZone.push(pState.deck.pop());
                }
            }
        }

        // 🛑 D. กรณี "ทำลาย Avatar ฝ่ายตรงข้าม" (ใช้ระบบ Target Selection ที่เพิ่งสร้าง)
        if (text.includes('ทำลาย Avatar') && text.includes('ฝ่ายตรงข้าม')) {
            if (io && socketId && oppState.board.avatarZone.length > 0) {
                game.pendingTargetAction = {
                    effectType: 'DESTROY_OPPONENT_AVATAR',
                    playerRole: playerRole
                };
                io.to(socketId).emit('request-target', {
                    message: `เลือก Avatar ฝ่ายตรงข้าม 1 ใบเพื่อทำลายจากความสามารถของ [${card.name}]`,
                    validTargets: oppState.board.avatarZone,
                    maxSelect: 1,
                    context: 'DESTROY_OPPONENT_AVATAR'
                });
            }
        }

        // 🛑 E. จั่วการ์ดทั่วไป
        if (text.includes('จั่วการ์ด') && !text.includes('ธรณีสูบ')) {
            let drawCount = 1;
            if (text.includes('3 ใบ')) drawCount = 3;
            else if (text.includes('2 ใบ')) drawCount = 2;
            for (let i = 0; i < drawCount; i++) {
                if (pState.deck.length > 0) {
                    pState.hand.push(pState.deck.pop());
                }
            }
        }
    }

    // 🛑 F. ระบบบัฟ/ดีบัฟ: อ่านข้อความ "เพิ่ม power +X จนถึง..." หรือ "ลด power -X จนถึง..."
    // ปรับ Regex ให้คำว่า "เพิ่ม" หรือ "ลด" ไม่จำเป็นต้องมีก็ได้
    let buffMatch = text.match(/(?:เพิ่ม|ลด)?\s*power\s*([+-]?\s*\d+)\s*จนถึง\s*(end phase|จบเทิร์น)/i);
    
    // เพิ่มการรองรับจังหวะ ON_AUTO_TRIGGER
    if (buffMatch && ['ON_PLAY_MAGIC', 'ON_ACTIVATE', 'ON_SUMMON', 'ON_AUTO_TRIGGER'].includes(triggerType)) {
        let amountStr = buffMatch[1].replace(/\s+/g, ''); // เอาช่องว่างออก เช่น "+ 2" เป็น "+2"
        let amount = parseInt(amountStr);
        // ถ้า text เขียนว่า "ลด" แต่พิมพ์ตัวเลขเป็นบวก ให้จับคูณ -1
        if (text.includes('ลด power') && amount > 0) amount = -amount; 
        
        let expireText = buffMatch[2].toLowerCase();
        let expireEvent = expireText.includes('end phase') ? 'END_PHASE' : 'END_TURN';

        // ถ้าระบุว่า "Avatar 1 ใบ" -> ให้เลือกเป้าหมาย
        if (text.includes('avatar 1 ใบ')) {
            if (io && socketId) {
                let allAvatars = [...pState.board.avatarZone, ...oppState.board.avatarZone];
                if (allAvatars.length > 0) {
                    game.pendingTargetAction = {
                        effectType: 'APPLY_BUFF',
                        playerRole: playerRole,
                        buffAmount: amount,
                        expireAt: expireEvent
                    };
                    io.to(socketId).emit('request-target', {
                        message: `เลือก Avatar 1 ใบ เพื่อรับ Effect พลัง ${amount}`,
                        validTargets: allAvatars,
                        maxSelect: 1,
                        context: 'APPLY_BUFF'
                    });
                }
            }
        } else {
            // ถ้าไม่ได้ระบุเป้าหมาย แปลว่าบัฟให้ตัวเอง!
            if (!card.tempEffects) card.tempEffects = [];
            card.tempEffects.push({ amount: amount, expireAt: expireEvent });
            console.log(`✨ [Buff Self] [${card.name}] ได้รับ ${amount} จนถึง ${expireEvent}`);
        }
    }

    // -------------------------------------------------------------------------
    // 2. ความสามารถประเภท "คำสั่งเสีย" (Last Will เมื่อถูกทำลายลงนรก)
    // -------------------------------------------------------------------------
    if (text.includes('คำสั่งเสีย') && triggerType === 'ON_DESTROYED') {
        console.log(`⚰️ [Keyword: คำสั่งเสีย] การ์ด [${card.name}] ทำงานจากนรก`);
        if (text.includes('จั่วการ์ด')) {
            let drawMatch = text.match(/จั่วการ์ด\s*(\d+)/);
            let drawCount = drawMatch ? parseInt(drawMatch[1]) : 1;
            for (let i = 0; i < drawCount; i++) {
                if (pState.deck.length > 0) pState.hand.push(pState.deck.pop());
            }
        }
        if (text.includes('นรก') && text.includes('ขึ้นมือ')) {
            if (pState.board.hellZone.length > 0) {
                pState.hand.push(pState.board.hellZone.pop());
            }
        }
    }
    // -------------------------------------------------------------------------
    // 🌟 ความสามารถเมื่อร่ายเวทมนตร์ (ON_PLAY_MAGIC)
    // -------------------------------------------------------------------------
    if (triggerType === 'ON_PLAY_MAGIC') {
        console.log(`🪄 [Keyword: ร่ายเวทมนตร์] การ์ด [${card.name}] แสดงผล!`);
        
        // เช็คการจั่วการ์ด (เช่น การ์ด "ความเจริญ": "จั่วการ์ดจาก Deck เรา 2 ใบ")
        if (text.includes('จั่วการ์ด')) {
            // จับตัวเลขว่าให้จั่วกี่ใบ (เช่น จับเลข 2 จาก "จั่วการ์ดจาก Deck เรา 2 ใบ")
            let drawMatch = text.match(/จั่วการ์ด.*?(\d+)\s*ใบ/);
            let drawCount = drawMatch ? parseInt(drawMatch[1]) : 1;
            
            console.log(`🎴 [Magic Effect] สั่งจั่วการ์ด ${drawCount} ใบ`);
            for (let i = 0; i < drawCount; i++) {
                if (pState.deck.length > 0) {
                    pState.hand.push(pState.deck.pop());
                }
            }
        }
        
        // เผื่ออนาคต: ดักเวทมนตร์โจมตี/ทำลายเป้าหมาย (เช่น การ์ด "บีมมมมมมมมมม")
        if (text.includes('ทำลาย Avatar') && text.includes('ฝ่ายตรงข้าม') && text.includes('1 ใบ')) {
             if (io && socketId && oppState.board.avatarZone.length > 0) {
                game.pendingTargetAction = {
                    effectType: 'DESTROY_OPPONENT_AVATAR',
                    playerRole: playerRole
                };
                io.to(socketId).emit('request-target', {
                    message: `เลือก Avatar ฝ่ายตรงข้าม 1 ใบเพื่อทำลายจากความสามารถของ [${card.name}]`,
                    validTargets: oppState.board.avatarZone,
                    maxSelect: 1,
                    context: 'DESTROY_OPPONENT_AVATAR'
                });
            }
        }
    }
}

// 👁️ นำฟังก์ชันจัดการระบบสอดแนม (Scout System) กลับมาไว้ด้านล่างสุดเหมือนเดิมครับ
export function handleScoutAbility(game, playerRole, scoutCount = 3) {
    let pState = game.players[playerRole];
    if (!pState || !pState.deck || pState.deck.length === 0) {
        console.log(`⚠️ [Scout] เด็คของ ${playerRole} หมดแล้ว ไม่สามารถสอดแนมได้`);
        return [];
    }

    let actualCount = Math.min(scoutCount, pState.deck.length);
    let scoutedCards = [];

    for (let i = 0; i < actualCount; i++) {
        scoutedCards.push(pState.deck.pop());
    }

    console.log(`👁️ [Scout] ผู้เล่น ${playerRole} สอดแนมเจอการ์ด ${scoutedCards.length} ใบ`);
    return scoutedCards;
}