import fs from 'fs';

console.log('⏳ กำลังวิเคราะห์และอัปเกรดฐานข้อมูลการ์ด (รองรับ Zone Activation และ Advanced Scout)...');

let rawData = fs.readFileSync('./cards.json', 'utf8');
let cards = JSON.parse(rawData);
let upgradedCount = 0;

// 🧠 ฟังก์ชันสกัดแหล่งที่มาของสกิล "สั่งใช้" (Source Zone Detection)
const parseSourceZone = (text) => {
    let lower = text.toLowerCase();
    if (lower.includes('จากบนมือ') || lower.includes('จากมือ')) return 'HAND';
    if (lower.includes('อกจากนรก') || lower.includes('จากนรก')) return 'HELL_ZONE';
    if (lower.includes('จากบน magic zone') || lower.includes('จาก magic zone')) return 'MAGIC_ZONE';
    if (lower.includes('จาก Construct Zone')) return 'CONSTRUCT_ZONE';
    return 'AVATAR_ZONE'; // ค่าเริ่มต้นถ้าเป็นการ์ดบนสนามปกติ
};

// 🧠 ฟังก์ชันสกัดระบบสอดแนมแบบละเอียด (Scout Parser)
const parseScoutAction = (text) => {
    if (!text.includes('สอดแนม') && !text.includes('สอดเเนม')) return null;

    // 1. หาจำนวนใบที่ต้องเปิดดู (เช่น สอดแนม 5 ใบ)
    let countMatch = text.match(/สอดเ?น?ม\s*(\d+)/);
    let scoutCount = countMatch ? parseInt(countMatch[1]) : 3;

    // 2. หาวิธีจัดการการ์ดที่เลือกหยิบ (เช่น เลือก 1 ใบขึ้นมือ)
    let pickMatch = text.match(/เลือก.*?\s*(\d+)?\s*ใบ.*?ขึ้นมือ/);
    let pickCount = pickMatch && pickMatch[1] ? parseInt(pickMatch[1]) : 1;

    // 3. หาชะตากรรมของการ์ดที่เหลือ (เช่น นำกลับเข้า Deck, สับ Deck, หรือส่งลงนรก)
    let destination = 'DECK_BOTTOM'; // ค่าเริ่มต้น
    let shouldShuffle = text.includes('สับ Deck') || text.includes('แล้วสับ');

    if (text.includes('ลงนรก')) destination = 'HELL_ZONE';
    else if (text.includes('ใต้ Deck') || text.includes('ไว้ใต้ Deck')) destination = 'DECK_BOTTOM';
    else if (text.includes('บนสุดของ Deck') || text.includes('วางไว้บนสุด')) destination = 'DECK_TOP';

    return {
        type: 'ADVANCED_SCOUT',
        scoutAmount: scoutCount,
        pickAmount: pickCount,
        remainingDestination: destination,
        shuffleDeck: shouldShuffle
    };
};

// 🧠 1. เพิ่มฟังก์ชันสกัดเงื่อนไขซับซ้อน (วางไว้เหนือ parseActions)
const parseComplexActivation = (text) => {
    let conditions = [];
    if (text.includes('หลังจากที่การ์ดต่อสู้') || text.includes('ทำลาย avatar อีกฝ่าย')) {
        conditions.push({ type: 'CONDITION_AFTER_COMBAT_DESTROY' });
    }
    if (text.includes('ส่ง') && text.includes('ลงนรก')) {
        conditions.push({ type: 'COST_SEND_TO_HELL' });
    }
    if (text.includes('อัญเชิญ') && text.includes('จากนรก')) {
        conditions.push({ type: 'EFFECT_SUMMON_FROM_HELL_BY_COST' });
    }
    return conditions;
};

// 🧠 2. อัปเดต parseActions เดิม ให้เรียกใช้ฟังก์ชันด้านบน
const parseActions = (text) => {
    let actions = [];
    
    // 👇 เพิ่มส่วนนี้เข้ามาสกัด Action พิเศษ
    let complexConds = parseComplexActivation(text);
    if (complexConds.length > 0) actions.push(...complexConds);

    // ตรวจสอบระบบสอดแนมขั้นสูง (ของเดิมที่คุณมี)
    let scoutObj = parseScoutAction(text);
    if (scoutObj) actions.push(scoutObj);

    if (text.includes('จั่วการ์ด')) {
        let m = text.match(/จั่วการ์ด.*?(?:เรา)?\s*(\d+)?/);
        actions.push({ type: 'DRAW', amount: m && m[1] ? parseInt(m[1]) : 1 });
    }
    if (text.match(/ทิ้งการ์ด|ทิ้งมือ|ทิ้ง Avatar|ทิ้ง.*?\s*ใบ/)) {
        let m = text.match(/ทิ้ง.*?\s*(\d+)?\s*ใบ/);
        actions.push({ type: 'DISCARD', amount: m && m[1] ? parseInt(m[1]) : 1 });
    }
    let buffMatch = text.match(/POWER\s*\+\s*(\d+)/i);
    if (buffMatch) actions.push({ type: 'BUFF', amount: parseInt(buffMatch[1]) });

    let debuffMatch = text.match(/POWER\s*-\s*(\d+)/i);
    if (debuffMatch) actions.push({ type: 'DEBUFF', amount: parseInt(debuffMatch[1]) });

    if (text.includes('นำกลับขึ้นมือ') || text.includes('ขึ้นมือ')) {
        actions.push({ type: 'RETURN_TO_HAND' });
    }
    if (text.includes('ธรณีสูบ')) {
        let m = text.match(/ธรณีสูบ\s*(\d+)?/);
        actions.push({ type: 'MILL', amount: m && m[1] ? parseInt(m[1]) : 1 });
    }
    if (text.includes('เซ่นไหว้')) actions.push({ type: 'SACRIFICE' });
    if (text.includes('เนรเทศ')) actions.push({ type: 'BANISH' });
    if (text.includes('ทำลาย')) actions.push({ type: 'DESTROY' });
    if (text.includes('เลือกปฏิบัติ')) actions.push({ type: 'CHOICE' });
    
    return actions;
};

// 🛡️ [เพิ่มใหม่] ฟังก์ชันตรวจจับว่า React ใบนี้ใช้โต้ตอบกับอะไร
const parseReactTrigger = (text) => {
    let lower = text.toLowerCase();
    // ถ้าเป็น React ที่ใช้ตอนอีกฝ่ายอัญเชิญ Avatar (เช่น เคี้ยวเพื่อนเธอซะ, อุบัติเหตุ)
    if (lower.includes('อัญเชิญ') && (lower.includes('avatar') || lower.includes('ลงมาบนสนาม'))) {
        return 'ON_OPPONENT_SUMMON';
    }
    // ถ้าเป็น React ที่ใช้ตอนอีกฝ่ายใช้เวทมนตร์ (เช่น ชายจากอนาคต, อย่าให้มีครั้งที่ 2)
    if (lower.includes('magic') || lower.includes('เวทมนตร์')) {
        return 'ON_OPPONENT_MAGIC';
    }
    // ถ้าเป็น React ที่ใช้ตอนถูกโจมตี (เช่น ไปเลยมอนตี้, ถวาย)
    if (lower.includes('ประกาศโจมตี') || lower.includes('ถูกทำลาย')) {
        return 'ON_OPPONENT_ATTACK';
    }
    return 'UNIVERSAL'; // ครอบจักรวาล
};

// 🔄 ลูปประมวลผล
cards = cards.map(card => {
    let text = card.abilityText || "";
    if (!text.trim()) return card; 

    let reactCondition = null;
    if ((card.type || '').toLowerCase() === 'magic' && (card.magicSubtype || '').toLowerCase() === 'react') {
        reactCondition = parseReactTrigger(text);
    }

    let quotesDb = [];
    let safeText = text.replace(/"(.*?)"/g, (match) => {
        quotesDb.push(match);
        return `__QUOTE_${quotesDb.length - 1}__`;
    });

    let blockSplitRegex = /(?=(?:เทิร์นละครั้ง|1 ครั้ง\/เทิร์น|พอดี|คู่หู\s+[ก-๙a-zA-Z0-9]+)?\s*(?:จุติ|สั่งใช้|อัตโนมัติ|คำสั่งเสีย|ต่อเนื่อง))/g;
    let blocks = safeText.split(blockSplitRegex).filter(b => b.trim().length > 0);

    let structuredAbilities = [];

    blocks.forEach(block => {
        let cleanBlock = block.trim();
        
        let triggerType = "UNKNOWN";
        if (cleanBlock.includes('จุติ')) triggerType = "ON_SUMMON";
        else if (cleanBlock.includes('สั่งใช้')) triggerType = "ON_ACTIVATE";
        else if (cleanBlock.includes('อัตโนมัติ')) triggerType = "ON_AUTO_TRIGGER";
        else if (cleanBlock.includes('คำสั่งเสีย')) triggerType = "ON_DESTROYED";
        else if (cleanBlock.includes('ต่อเนื่อง')) triggerType = "ON_CONTINUOUS";

        if (triggerType === "UNKNOWN") return;

        let isOncePerTurn = cleanBlock.includes('เทิร์นละครั้ง') || cleanBlock.includes('1 ครั้ง/เทิร์น');
        let requiredSourceZone = parseSourceZone(cleanBlock); // 👈 ตรวจสอบว่าต้องสั่งใช้จากไหน!

        let costContext = "NO_COST";
        let effectContext = cleanBlock;

        let splitIndex = cleanBlock.indexOf(" : ");
        if (splitIndex !== -1) {
            costContext = cleanBlock.substring(0, splitIndex).trim();
            effectContext = cleanBlock.substring(splitIndex + 3).trim();
        }

        quotesDb.forEach((quote, index) => {
            costContext = costContext.replace(`__QUOTE_${index}__`, quote);
            effectContext = effectContext.replace(`__QUOTE_${index}__`, quote);
        });

        structuredAbilities.push({
            trigger: triggerType,
            requiredZone: requiredSourceZone, // บันทึกโซนที่อนุญาตให้กดใช้
            isOncePerTurn: isOncePerTurn,
            cost: {
                rawText: costContext,
                actions: parseActions(costContext)
            },
            effect: {
                rawText: effectContext,
                actions: parseActions(effectContext)
            }
        });
    });

    if (structuredAbilities.length > 0) upgradedCount++;

    return { 
        ...card,
        reactCondition: reactCondition,
        structuredAbilities: structuredAbilities.length > 0 ? structuredAbilities : undefined
    };
});

fs.writeFileSync('./cards.json', JSON.stringify(cards, null, 2), 'utf8');
console.log(`🎉 อัปเกรดสำเร็จ ${upgradedCount} ใบ บันทึกที่ cards.json`);