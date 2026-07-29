// ==========================================
// สคริปต์แยกการ์ด "แทงหลัง" และกรองชื่อซ้ำ (เอาชื่อละ 1 ใบเท่านั้น)
// ==========================================
const fs = require('fs');

async function extractUniqueThaengHangCards() {
    try {
        console.log(`> กำลังอ่านข้อมูลจากไฟล์ cards.json...`);
        
        if (!fs.existsSync('cards.json')) {
            console.error(`❌ ไม่พบไฟล์ cards.json กรุณาตรวจสอบว่ามีไฟล์อยู่ในโฟลเดอร์หรือไม่`);
            return;
        }

        const rawData = fs.readFileSync('cards.json', 'utf-8');
        const allCards = JSON.parse(rawData);

        console.log(`> กำลังคัดกรองการ์ดที่มีคำว่า "แทงหลัง" และตัดชื่อที่ซ้ำกันออก...`);

        // 1. กรองเฉพาะการ์ดที่มีคำว่า "แทงหลัง" ใน abilityText
        const thaengHangCards = allCards.filter(card => {
            const ability = card.abilityText || '';
            return ability.includes('แทงหลัง');
        });

        // 2. กรองไม่ให้มีชื่อซ้ำกัน (เก็บเฉพาะใบแรกของแต่ละชื่อ)
        const uniqueCardsMap = new Map();
        thaengHangCards.forEach(card => {
            const cardName = card.name ? card.name.trim() : '';
            if (cardName && !uniqueCardsMap.has(cardName)) {
                uniqueCardsMap.set(cardName, card);
            }
        });

        // แปลง Map กลับเป็น Array
        const uniqueThaengHangCards = Array.from(uniqueCardsMap.values());

        // บันทึกลงไฟล์ใหม่ชื่อ unique-thaenghang-cards.json
        const outputFilename = 'unique-thaenghang-cards.json';
        fs.writeFileSync(outputFilename, JSON.stringify(uniqueThaengHangCards, null, 2), 'utf-8');

        console.log(`✅ คัดแยกและกรองสำเร็จ! พบการ์ด "แทงหลัง" ที่ชื่อไม่ซ้ำกันทั้งหมด ${uniqueThaengHangCards.length} ใบ`);
        console.log(`📁 บันทึกข้อมูลลงในไฟล์เรียบร้อยแล้ว: ${outputFilename}`);

        // แสดงตัวอย่างชื่อการ์ด 5 ใบแรกที่คัดกรองแล้ว
        if (uniqueThaengHangCards.length > 0) {
            console.log(`\n--- ตัวอย่างการ์ดแทงหลัง (ชื่อไม่ซ้ำ) ---`);
            uniqueThaengHangCards.slice(0, 5).forEach((c, idx) => {
                console.log(`${idx + 1}. [${c.id}] ${c.name} -> ความสามารถ: ${c.abilityText}`);
            });
            if (uniqueThaengHangCards.length > 5) {
                console.log(`... และอื่นๆอีก ${uniqueThaengHangCards.length - 5} ใบ`);
            }
        }

    } catch (error) {
        console.error('❌ เกิดข้อผิดพลาดระหว่างแยกข้อมูล:', error.message);
    }
}

// รันฟังก์ชัน
extractUniqueThaengHangCards();