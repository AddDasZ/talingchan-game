// ==========================================
// ศูนย์กลางระบบเวทมนตร์ (Magic Engine)
// รองรับ: Normal, Modification, React, Land Magic
// ระบบ Asynchronous (รอการตอบโต้จากอีกฝ่าย)
// ==========================================

import { processCardAbilities } from './abilityEngine.js';

// 🔀 ฟังก์ชันช่วยแยกข้อย่อยจากการ์ดที่มีคำว่า "เลือกปฏิบัติ"
export function extractChoiceOptions(abilityText) {
    let options = [];
    let matches = abilityText.split(/(?:\d+[\.\)]\s*)/);
    if (matches.length > 1) {
        options = matches.slice(1).map(s => s.trim());
    } else {
        options = ["ทำผลลัพธ์ข้อย่อยที่ 1", "ทำผลลัพธ์ข้อย่อยที่ 2"];
    }
    return options;
}

// -------------------------------------------------------------------------
// 🪄 จังหวะที่ 1: ผู้เล่นประกาศร่ายเวทมนตร์ (ตรวจโควต้า, หักการ์ด, ถามอีกฝ่าย)
// -------------------------------------------------------------------------
export function playMagicCard(game, playerRole, cardIndex, targetAvatarId, io, socket, roomName, originalCardInfo) {
    let pState = game.players[playerRole];
    let magicCardCheck = pState.hand[cardIndex];

    // 🔍 อ่านข้อมูลการ์ดเพื่อตรวจสอบประเภท
    let subType = originalCardInfo ? (originalCardInfo.magicSubtype || '') : (magicCardCheck.magicSubtype || '');
    let cardType = originalCardInfo ? (originalCardInfo.type || '') : (magicCardCheck.type || '');
    let name = magicCardCheck.name || '';
    let ability = originalCardInfo ? (originalCardInfo.abilityText || '') : (magicCardCheck.abilityText || '');

    // 🌍 จัดกลุ่มประเภทของ Magic เพื่อใช้เช็คโควต้า
    let resolvedMagicType = 'Normal'; 
    let isLandCard = (subType.trim().toLowerCase() === 'land' || 
                      cardType.trim().toLowerCase() === 'land' || 
                      (originalCardInfo && originalCardInfo.magicSubtype === 'Land') ||
                      name.includes('เขาไกรลาส') || name.includes('ดินแดน') || name.includes('ทุ่งนา') || 
                      name.includes('มวยทะเล') || name.includes('โรงบาล') || name.includes('ประตูนรก') || 
                      name.includes('เทศกาล') || name.includes('แอสการ์ด') || name.includes('อาณาจักร') || 
                      name.includes('กาฬสินธุ์') || name.includes('ราชธานี') || name.includes('ปราสาท') || 
                      name.includes('สมาคม') || name.includes('พิภพ') || name.includes('Podcast') || 
                      name.includes('Hot Zone') || name.includes('ทรายดูด') || name.includes('กรุงลงกา') || 
                      name.includes('ฐานหุ่น') || name.includes('บึงทมิฬ'));
    
    let isMod = (subType.toLowerCase() === 'modification' || ability.includes('สวมใส่'));
    let isReact = (subType.toLowerCase() === 'react');

    if (isLandCard) resolvedMagicType = 'Land';
    else if (isMod) resolvedMagicType = 'Modification';
    else if (isReact) resolvedMagicType = 'React';

    // 🛑 ตรวจสอบโควต้าการใช้ Magic (ประเภทละ 1 ครั้ง ต่อ 1 เทิร์น)
    if (!game.magicUsage) game.magicUsage = {};
    let usageKey = `${playerRole}_${resolvedMagicType}`;

    if (game.magicUsage[usageKey]) {
        socket.emit('error-message', `❌ คุณใช้งาน Magic ประเภท [${resolvedMagicType}] ไปแล้วในเทิร์นนี้ (จำกัดประเภทละ 1 ครั้งต่อเทิร์น)`);
        return false;
    }

    // ✅ ถ้าผ่านการตรวจสอบ ให้หักการ์ดออกจากมือ และบันทึกประวัติการใช้งาน
    let magicCard = pState.hand.splice(cardIndex, 1)[0];
    game.magicUsage[usageKey] = true;

    // 🛑 ถ้าเป็น "เลือกปฏิบัติ" ให้แสดงหน้าต่างให้เจ้าของตัวเลือกก่อน
    let abilityText = (ability || magicCard.abilityText || "").toLowerCase();
    if (abilityText.includes('เลือกปฏิบัติ')) {
        pState.board.magicZone.push(magicCard);
        let options = extractChoiceOptions(abilityText);
        io.to(socket.id).emit('open-choice-modal', {
            cardName: magicCard.name,
            options: options,
            cardId: magicCard.uniqueId || magicCard.id
        });
        return true; 
    }

    // ⚡ ห่อหุ้มการทำงานของการ์ด ส่งเข้ากล่อง Pending Action
    game.pendingAction = {
        type: 'PLAY_MAGIC',
        playerRole: playerRole,
        magicCard: magicCard,
        targetAvatarId: targetAvatarId,
        isLandCard: isLandCard,
        isMod: isMod,
        resolvedMagicType: resolvedMagicType
    };

    // กำหนดว่าใครคือฝ่ายตรงข้าม
    let opponentRole = (playerRole === 'playerA') ? 'playerB' : 'playerA';
    let oppState = game.players[opponentRole];

    // 👉 เช็คว่าฝ่ายตรงข้ามมีการ์ดประเภท React บนมือหรือไม่
    let hasReactCard = oppState.hand.some(c => {
        let cType = (c.type || '').toLowerCase();
        let sType = (c.magicSubtype || '').toLowerCase();
        return cType === 'magic' && sType === 'react';
    });

    if (hasReactCard) {
        // ถ้ามีการ์ด ให้รอก่อน และส่งหน้าต่างไปถาม
        game.reactionWaitingFor = opponentRole;
        io.to(oppState.id).emit('prompt-reaction', { 
            message: `ฝ่ายตรงข้ามกำลังใช้งานเวทมนตร์ [${magicCard.name}]` 
        });
    } else {
        // 👉 ถ้าไม่มีการ์ด React ให้เซ็ตสถานะเป็นไม่ต้องรอใครเลย
        game.reactionWaitingFor = null;
    }

    return true;
}

// -------------------------------------------------------------------------
// 💥 จังหวะที่ 2: แสดงผลเวทมนตร์ (หลังอีกฝ่ายตอบสนองเสร็จสิ้น)
// -------------------------------------------------------------------------
export function resolvePendingMagic(game, action, roomName, io, broadcastGameState) {
    let pState = game.players[action.playerRole];

    if (action.isLandCard) {
        if (game.landMagicZone && game.landMagicZone.card) {
            let oldOwner = game.players[game.landMagicZone.owner];
            if (oldOwner) oldOwner.board.hellZone.push(game.landMagicZone.card);
        }
        game.landMagicZone = { card: action.magicCard, owner: action.playerRole };
    } else {
        if (action.isMod && action.targetAvatarId) {
            let targetAvatar = pState.board.avatarZone.find(a => a.id === action.targetAvatarId || a.uniqueId === action.targetAvatarId);
            if (targetAvatar) {
                if (!targetAvatar.equippedCards) targetAvatar.equippedCards = [];
                targetAvatar.equippedCards.push(action.magicCard);
            }
        }

        // นำการ์ดร่ายปกติ หรือ สวมใส่ ลงไปประดับไว้ใน Magic Zone ก่อน
        pState.board.magicZone.push(action.magicCard);

        // 🌟 เรียกใช้ Ability Engine เพื่อประมวลผลเอฟเฟกต์เวทมนตร์
        processCardAbilities(game, action.playerRole, action.magicCard, 'ON_PLAY_MAGIC', 1, false, io, pState.id);

        // ถ้าเป็น Normal หรือ React เมื่อแสดงผลจบต้องตกนรก (หน่วงเวลาไว้ให้เห็นบนจอก่อน 3 วิ)
        if (action.resolvedMagicType === 'Normal' || action.resolvedMagicType === 'React') {
            setTimeout(() => {
                let latestPState = game.players[action.playerRole]; 
                if (latestPState) {
                    let mIndex = latestPState.board.magicZone.findIndex(c => c.uniqueId === action.magicCard.uniqueId || c.id === action.magicCard.id);
                    if (mIndex !== -1) {
                        let usedMagic = latestPState.board.magicZone.splice(mIndex, 1)[0];
                        latestPState.board.hellZone.push(usedMagic);
                        console.log(`🪦 [Magic Resolve] การ์ดเวทมนตร์ [${usedMagic.name}] ทำงานเสร็จและตกนรกแล้ว`);
                        broadcastGameState(roomName, game); // ส่งอัปเดตหน้าจออีกรอบ
                    }
                }
            }, 3000); 
        }
    }
}