// ==========================================
// ระบบการต่อสู้และคำนวณพลัง (Battle Engine)
// รองรับ: การต่อสู้ระหว่าง Avatar และการโจมตีผู้เล่นโดยตรง (Direct Attack)
// ==========================================

// ฟังก์ชันคำนวณ Effect Layers (Layer 0 - 4)
export function calculateNetPower(avatarCard, boardState = {}) {
    let power = avatarCard.basePower || 0;

    // Layer 1: บัฟทางตรง
    if (avatarCard.modifiers) {
        avatarCard.modifiers.filter(m => m.layer === 1 || !m.layer).forEach(buff => {
            power += buff.powerChange || 0;
        });
    }

    // Layer 2: บัฟทางอ้อมจากสนาม
    if (boardState.landMagicZone) {
        power += boardState.landMagicZone.effectPower || 0;
    }

    let snapshotPower = power;

    // Layer 4: บัฟฉุกเฉิน / React Magic
    if (avatarCard.modifiers) {
        avatarCard.modifiers.filter(m => m.layer === 4).forEach(buff => {
            snapshotPower += buff.powerChange || 0;
        });
    }

    return snapshotPower;
}

// ฟังก์ชันตัดสินผลต่อสู้ระหว่าง Avatar กับ Avatar
export function resolveCombat(gameState, attackerPlayer, attackerId, defenderPlayer, defenderId) {
    let attackerZone = gameState.players[attackerPlayer].board.avatarZone;
    let defenderZone = gameState.players[defenderPlayer].board.avatarZone;

    let attackerIndex = attackerZone.findIndex(c => c.id === attackerId);
    let defenderIndex = defenderZone.findIndex(c => c.id === defenderId);

    if (attackerIndex === -1 || defenderIndex === -1) {
        console.log("❌ ข้อผิดพลาด: ไม่พบการ์ดคู่ต่อสู้บนสนาม");
        return;
    }

    let attackerCard = attackerZone[attackerIndex];
    let defenderCard = defenderZone[defenderIndex];

    let attackerPower = calculateNetPower(attackerCard, gameState.players[attackerPlayer].board);
    let defenderPower = calculateNetPower(defenderCard, gameState.players[defenderPlayer].board);

    console.log(`\n⚔️ [Battle] ${attackerCard.name} (${attackerPower}) VS ${defenderCard.name} (${defenderPower})`);

    if (attackerPower > defenderPower) {
        console.log(`> [${attackerCard.name}] ชนะ! [${defenderCard.name}] ถูกส่งลงนรก`);
        gameState.players[defenderPlayer].board.hellZone.push(defenderZone.splice(defenderIndex, 1)[0]);
    } else if (defenderPower > attackerPower) {
        console.log(`> [${defenderCard.name}] ชนะ! [${attackerCard.name}] ถูกส่งลงนรก`);
        gameState.players[attackerPlayer].board.hellZone.push(attackerZone.splice(attackerIndex, 1)[0]);
    } else {
        console.log(`> พลังเท่ากัน! ทำลายทั้งคู่`);
        gameState.players[attackerPlayer].board.hellZone.push(attackerZone.splice(attackerIndex, 1)[0]);
        gameState.players[defenderPlayer].board.hellZone.push(defenderZone.splice(defenderIndex, 1)[0]);
    }
}

// ฟังก์ชันสั่งโจมตี (รองรับทั้งโจมตี Avatar และโจมตีผู้เล่นโดยตรง)
export function declareAttack(gameState, attackerRole, attackerId, targetType, targetId = null) {
    let attackerPlayerState = gameState.players[attackerRole];
    let defenderRole = attackerRole === 'player1' ? 'player2' : 'player1';
    let defenderPlayerState = gameState.players[defenderRole];

    let attackerZone = attackerPlayerState.board.avatarZone;
    let attackerIndex = attackerZone.findIndex(c => c.id === attackerId);

    if (attackerIndex === -1) {
        console.log(`❌ [โจมตีล้มเหลว] ไม่พบ Avatar ผู้โจมตีบนสนาม`);
        return false;
    }

    let attackerCard = attackerZone[attackerIndex];

    // ตรวจสอบสภาพการตื่น/นอน (ถ้ากำลังนอนอยู่ ห้ามโจมตี)
    if (attackerCard.isResting) {
        console.log(`❌ [โจมตีล้มเหลว] การ์ด [${attackerCard.name}] อยู่ในสภาพนอน ไม่สามารถโจมตีได้`);
        return false;
    }

    // -------------------------------------------------------------------------
    // 1. กรณีสั่งโจมตีผู้เล่นโดยตรง (Direct Attack)
    // -------------------------------------------------------------------------
    if (targetType === 'PLAYER') {
        // กฎเหล็ก: ห้ามโจมตีผู้เล่นถ้าบน Avatar Zone ฝ่ายตรงข้ามยังมี Avatar เหลืออยู่
        if (defenderPlayerState.board.avatarZone.length > 0) {
            console.log(`❌ [Direct Attack ล้มเหลว] ไม่สามารถโจมตีผู้เล่นได้ เนื่องจากยังมี Avatar ฝ่ายตรงข้ามเหลืออยู่บนสนาม`);
            return false;
        }

        console.log(`🎯 [Direct Attack] Avatar [${attackerCard.name}] โจมตีใส่ผู้เล่น ${defenderRole} โดยตรงสำเร็จ!`);

        // การเสีย Life: ค้นหา Life Card ใบแรกที่ยังคว่ำอยู่ แล้วทำการหงายขึ้น
        if (defenderPlayerState.lifeZone && defenderPlayerState.lifeZone.length > 0) {
            let faceDownLife = defenderPlayerState.lifeZone.find(card => !card.isRevealed);
            
            if (faceDownLife) {
                faceDownLife.isRevealed = true;
                console.log(`💖 [Life Loss] ผู้เล่น ${defenderRole} สูญเสีย Life 1 ใบ! ทำการหงายการ์ดสำเร็จ`);
            } else {
                console.log(`💀 [Game Over] ผู้เล่น ${defenderRole} ไม่มี Life Card คว่ำเหลืออยู่แล้ว!`);
            }
        } else {
            console.log(`⚠️ ไม่พบโซน Life Card ของผู้เล่น ${defenderRole}`);
        }

        // หลังโจมตีเสร็จ เปลี่ยนสภาพ Avatar ผู้โจมตีเป็นสภาพนอน (Resting)
        attackerCard.isResting = true;
        return true;
    }

    // -------------------------------------------------------------------------
    // 2. กรณีโจมตี Avatar ฝ่ายตรงข้ามตามปกติ
    // -------------------------------------------------------------------------
    if (targetType === 'AVATAR') {
        if (!targetId) {
            console.log(`❌ [โจมตีล้มเหลว] ไม่ได้ระบุเป้าหมาย Avatar ฝ่ายตรงข้าม`);
            return false;
        }

        resolveCombat(gameState, attackerRole, attackerId, defenderRole, targetId);
        attackerCard.isResting = true;
        return true;
    }

    return false;
}