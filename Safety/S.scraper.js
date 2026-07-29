// ==========================================
// Scraper ฉบับดึงข้อมูลการ์ดทั้งหมด
// ==========================================
import puppeteer from 'puppeteer';
import fs from 'fs';

const TARGET_URL = 'https://bottcg.com/cards';

async function scrapeAllCardsComplete() {
    console.log(`> กำลังเริ่มดึงข้อมูลการ์ดทั้งหมด...`);
    
    const browser = await puppeteer.launch({ headless: true, protocolTimeout: 0 });
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(0);

    try {
        await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
        await new Promise(r => setTimeout(r, 4000));

        // ดึงจำนวนการ์ดทั้งหมดจากหน้าเว็บ
        const cardCount = await page.evaluate(() => 
            Array.from(document.querySelectorAll('img')).filter(img => img.src && img.src.includes('bangbon.app/cards/')).length
        );

        const uniqueCardsMap = new Map();
        
        // กำหนดให้ดึงจนครบจำนวนการ์ดทั้งหมดที่มี
        const limit = cardCount; 

        for (let i = 0; i < limit; i++) {
            await page.evaluate((index) => {
                const allImages = Array.from(document.querySelectorAll('img')).filter(img => img.src && img.src.includes('bangbon.app/cards/'));
                if (allImages[index]) {
                    const el = allImages[index].closest('div.relative') || allImages[index].parentElement;
                    el.click();
                }
            }, i);

            await new Promise(r => setTimeout(r, 800)); // หน่วงเวลาเพื่อให้ Modal โหลดข้อมูล[cite: 9]

            const cardData = await page.evaluate(() => {
                const modal = document.querySelector('div.fixed.inset-0') || document.body;
                
                const getVal = (label) => {
                    const rows = Array.from(modal.querySelectorAll('.flex.items-baseline.gap-1'));
                    const row = rows.find(r => r.innerText.includes(label + ':'));
                    return row ? row.innerText.replace(label + ':', '').trim() : '';
                };

                let data = {
                    id: getVal('รหัส'),
                    name: modal.querySelector('h2')?.innerText.trim() || 'Unknown',
                    type: getVal('ประเภท'),
                    magicSubtype: null,
                    rarity: getVal('ความหายาก'),
                    cost: parseInt(getVal('ค่าใช้')) || 0,
                    basePower: parseInt(getVal('พลัง')) || 0,
                    gem: parseInt(getVal('เจม') || getVal('gem')) || 0,
                    soi: parseInt(getVal('ซอย')) || 1,
                    color: getVal('สี'),
                    symbol: getVal('สัญลักษณ์'),
                    special: getVal('พิเศษ'),
                    imageUrl: modal.querySelector('img')?.src || '',
                    abilityText: ''
                };

                const badges = modal.querySelectorAll('.bg-bot-black.text-white, .bg-white.border-2');
                data.magicSubtype = Array.from(badges).map(b => b.innerText.trim()).find(t => ['Normal', 'Modification', 'React', 'Land'].includes(t)) || null;

                const abilityBox = modal.querySelector('div.text-bot-black.bg-white.p-3.rounded-xl.loose.border-2, div.text-bot-black.bg-white.p-3.rounded-xl');
                if (abilityBox) {
                    let cloneBox = abilityBox.cloneNode(true);
                    
                    cloneBox.querySelectorAll('img').forEach(imgEl => {
                        let alt = imgEl.getAttribute('alt') || '';
                        let src = imgEl.getAttribute('src') || '';
                        if (src.includes('mod.png')) imgEl.replaceWith('{Modification}');
                        else if (src.includes('land.png')) imgEl.replaceWith('{Land}');
                        else if (src.includes('magic.png')) imgEl.replaceWith('{Normal}');
                        else if (src.includes('react.png')) imgEl.replaceWith('{React}');
                        else if (alt) imgEl.replaceWith(`{${alt}}`);
                    });

                    cloneBox.querySelectorAll('[class*="bg-symbol"]').forEach(el => {
                        let match = el.className.match(/bg-([^\s]+)/g);
                        if (match) {
                            let val = match.find(m => m !== 'bg-symbol')?.replace('bg-', '');
                            if (val) el.replaceWith(`{${val}}`);
                        }
                    });

                    // 👇 3. [เพิ่มใหม่] ดักจับไอคอน คู่หู (Link) ที่เป็น SVG แล้วแปลงเป็นคำว่า "คู่หู "
                    cloneBox.querySelectorAll('svg.lucide-link').forEach(svgEl => {
                        svgEl.replaceWith('คู่หู ');
                    });
                    
                    data.abilityText = cloneBox.innerText.replace(/\s+/g, ' ').trim();
                }
                return data;
            });

            const uniqueKey = `${cardData.id}-${cardData.rarity}`;
            if (cardData.id && !uniqueCardsMap.has(uniqueKey)) {
                uniqueCardsMap.set(uniqueKey, cardData);
            }

            await page.evaluate(() => {
                const closeBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('ปิด'));
                if (closeBtn) closeBtn.click();
            });
            await new Promise(r => setTimeout(r, 200));
            
            // แสดงสถานะการทำงานทุก 50 ใบ เพื่อให้คุณทราบความคืบหน้า[cite: 9]
            if ((i + 1) % 50 === 0) console.log(`> ดำเนินการไปแล้ว ${i + 1} ใบ...`);
        }

        fs.writeFileSync('cards.json', JSON.stringify(Array.from(uniqueCardsMap.values()), null, 2), 'utf-8');
        console.log(`✅ ดึงข้อมูลสำเร็จ! รวมทั้งสิ้น ${uniqueCardsMap.size} ใบ`);

    } catch (error) {
        console.error('❌ เกิดข้อผิดพลาด:', error);
    } finally {
        await browser.close();
    }
}

scrapeAllCardsComplete();