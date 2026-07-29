// ==========================================
// Scraper ฉบับอัปเกรดสปีดขั้นสุด (Dynamic Wait + SVG Link Handling)
// ==========================================
import puppeteer from 'puppeteer';
import fs from 'fs';

const TARGET_URL = 'https://bottcg.com/cards';

async function scrapeAllCardsFast() {
    console.log(`🚀 กำลังเริ่มดึงข้อมูลการ์ดทั้งหมด (High Performance Mode)...`);
    const startTime = Date.now();
    
    const browser = await puppeteer.launch({ 
        headless: true, 
        protocolTimeout: 0,
        args: ['--no-sandbox', '--disable-setuid-sandbox'] 
    });
    
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(0);

    // ⚡ เพิ่มการบล็อกการโหลดไฟล์ภาพและ CSS เพื่อลดภาระหน้าเว็บขณะขูดข้อมูล
    await page.setRequestInterception(true);
    page.on('request', (req) => {
        const resourceType = req.resourceType();
        // อนุญาตเฉพาะ Document, Script และ Fetch เท่านั้น (บล็อก image, stylesheet, font)
        if (['stylesheet', 'font'].includes(resourceType)) {
            req.abort();
        } else {
            req.continue();
        }
    });

    try {
        await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });

        // รอจนกว่ารูปภาพการ์ดใบแรกบนหน้าเว็บจะปรากฏขึ้น
        await page.waitForSelector('img[src*="bangbon.app/cards/"]', { timeout: 15000 });

        // ดึงจำนวนการ์ดทั้งหมดที่มีบนหน้าเว็บ
        const cardCount = await page.evaluate(() => 
            Array.from(document.querySelectorAll('img')).filter(img => img.src && img.src.includes('bangbon.app/cards/')).length
        );

        console.log(`📦 พบการ์ดทั้งหมดบนหน้าเว็บ: ${cardCount} ใบ`);

        const uniqueCardsMap = new Map();

        for (let i = 0; i < cardCount; i++) {
            // 1. สั่งคลิกเปิดการ์ดตาม Index
            await page.evaluate((index) => {
                const allImages = Array.from(document.querySelectorAll('img')).filter(img => img.src && img.src.includes('bangbon.app/cards/'));
                if (allImages[index]) {
                    const el = allImages[index].closest('div.relative') || allImages[index].parentElement;
                    el.click();
                }
            }, i);

            // ⚡ 2. รอจนกว่า Modal และข้อมูลการ์ดจะเด้งขึ้นมาจริง (ดึงเร็วที่สุดที่ DOM พร้อม)
            await page.waitForFunction(() => {
                const modal = document.querySelector('div.fixed.inset-0');
                return modal && modal.querySelector('h2') && modal.innerText.trim().length > 0;
            }, { timeout: 3000 }).catch(() => {});

            // 3. อ่านข้อมูลการ์ดภายใน Modal
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
                    
                    // แปลงไอคอนเวทมนตร์ต่างๆ
                    cloneBox.querySelectorAll('img').forEach(imgEl => {
                        let alt = imgEl.getAttribute('alt') || '';
                        let src = imgEl.getAttribute('src') || '';
                        if (src.includes('mod.png')) imgEl.replaceWith('{Modification}');
                        else if (src.includes('land.png')) imgEl.replaceWith('{Land}');
                        else if (src.includes('magic.png')) imgEl.replaceWith('{Normal}');
                        else if (src.includes('react.png')) imgEl.replaceWith('{React}');
                        else if (alt) imgEl.replaceWith(`{${alt}}`);
                    });

                    // แปลงสัญลักษณ์เผ่าพันธุ์
                    cloneBox.querySelectorAll('[class*="bg-symbol"]').forEach(el => {
                        let match = el.className.match(/bg-([^\s]+)/g);
                        if (match) {
                            let val = match.find(m => m !== 'bg-symbol')?.replace('bg-', '');
                            if (val) el.replaceWith(`{${val}}`);
                        }
                    });

                    // 🔗 ดักจับและแปลงไอคอน SVG คู่หู (Link) เป็นคำว่า "คู่หู "
                    cloneBox.querySelectorAll('svg.lucide-link').forEach(svgEl => {
                        svgEl.replaceWith('คู่หู ');
                    });
                    
                    data.abilityText = cloneBox.innerText.replace(/\s+/g, ' ').trim();
                }
                return data;
            });

            // บันทึกการ์ดลง Map (กันซ้ำ)
            const uniqueKey = `${cardData.id}-${cardData.rarity}`;
            if (cardData.id && !uniqueCardsMap.has(uniqueKey)) {
                uniqueCardsMap.set(uniqueKey, cardData);
            }

            // 4. สั่งกดปิด Modal
            await page.evaluate(() => {
                const closeBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('ปิด'));
                if (closeBtn) closeBtn.click();
            });
            
            // ⚡ 5. รอจนกว่า Modal จะหายไปจากกระดานก่อนไปใบถัดไป
            await page.waitForFunction(() => {
                return !document.querySelector('div.fixed.inset-0');
            }, { timeout: 1000 }).catch(() => {});

            // Log รายงานผลทุกๆ 50 ใบ[cite: 9]
            if ((i + 1) % 50 === 0 || (i + 1) === cardCount) {
                console.log(`⚡ ดึงข้อมูลไปแล้ว ${i + 1} / ${cardCount} ใบ...`);
            }
        }

        // เซฟเข้าไฟล์ cards.json
        fs.writeFileSync('cards.json', JSON.stringify(Array.from(uniqueCardsMap.values()), null, 2), 'utf-8');
        
        const endTime = Date.now();
        const totalTime = ((endTime - startTime) / 1000).toFixed(2);
        console.log(`✅ ดึงข้อมูลสำเร็จทั้งหมด ${uniqueCardsMap.size} ใบ! (ใช้เวลาเพียง ${totalTime} วินาที)`);

    } catch (error) {
        console.error('❌ เกิดข้อผิดพลาดขณะทำงาน:', error);
    } finally {
        await browser.close();
    }
}

scrapeAllCardsFast();