// ==========================================
// ระบบตรวจสอบกฎกติกา (Rules Engine)
// ==========================================

// ฟังก์ชันเช็กขีดจำกัดพื้นที่ Avatar Zone
export function checkZoneLimits(playerState, isToken) {
    let zone = playerState.board.avatarZone;
    let totalCards = zone.length;
    let avatarCount = zone.filter(c => c.isToken === false).length;

    // กติกา: โควตารวมห้ามเกิน 6 ใบ
    if (totalCards >= 6) {
        console.log(`❌ ลงไม่ได้: Avatar Zone เต็มแล้ว (มีการ์ดรวม ${totalCards}/6 ใบ)`);
        return false;
    }

    // กติกา: ถ้าไม่ใช่ Token (เป็น Avatar จริง) ห้ามเกิน 4 ใบ
    if (!isToken && avatarCount >= 4) {
        console.log(`❌ ลงไม่ได้: มี Avatar ครบ 4 ใบแล้ว (ถ้าจะลงเพิ่ม ต้องอัญเชิญเป็น Token เท่านั้น)`);
        return false;
    }

    return true;
}

// ฟังก์ชันเช็กกติกา Construct Zone (ห้ามชื่อซ้ำกัน)
export function checkConstructDuplicate(constructZone, cardToPlay) {
    if (constructZone.length >= 3) {
        console.log("❌ ล้มเหลว: Construct Zone เต็มแล้ว (สูงสุด 3 ใบ)");
        return false;
    }

    let isNameDuplicate = constructZone.some(c => c.name === cardToPlay.name);
    if (isNameDuplicate) {
        console.log(`❌ ล้มเหลว: มี Construct ชื่อ "${cardToPlay.name}" อยู่บนสนามแล้ว`);
        return false;
    }

    return true;
}