# Discord AI Agent (Hermes-Lite)

บอท AI Agent สำหรับ Discord ที่ใช้ได้ฟรี ตั้งค่าครั้งเดียว ทำงาน 24 ชม. จาก iPhone ล้วน ๆ

## ความสามารถ

| คำสั่ง | ทำอะไร |
|---|---|
| `/ask` คำถาม | คุยกับ AI โดยจำบทสนทนาในห้องนั้นได้ 20 ตอนล่าสุด |
| `/ask` + web: เปิด | ค้นข้อมูล/ข่าวจากอินเทอร์เน็ต (DuckDuckGo) ก่อนตอบ พร้อมแหล่งอ้างอิง |
| `/image` คำบรรยาย | สร้างรูปภาพจากข้อความ (Pollinations ฟรี ไม่ต้องสมัคร) |
| `/model` | ดูรายการโมเดลฟรีล่าสุดจาก OpenRouter + เปลี่ยนโมเดล |
| `/reset` | ล้างความจำบทสนทนาในห้อง |
| `/files` | ดูรายการ PDF ที่บอทจำไว้สำหรับคุณในห้องนั้น |
| `/forget` | ลบ PDF ของคุณออกจากคลังความจำถาวร |
| `/help` | ดูวิธีใช้ทั้งหมด |

บอทจะเก็บข้อความจาก PDF ที่คุณอัปโหลดไว้ในคลังเอกสารแยกตาม Discord user และห้อง
เพื่อให้ถามต่อด้วย `/ask` ได้ภายหลัง โดยจะไม่เปิดเอกสารของผู้ใช้คนหนึ่งให้ผู้ใช้อื่นในห้องเดียวกัน

> **การเก็บข้อมูลบน Render Free:** ระบบใช้ไฟล์ JSON ตามค่า `FILE_MEMORY_PATH`
> (ค่าเริ่มต้นคือ `data/document-memory.json`) แต่ Render Free อาจลบไฟล์เมื่อมีการ deploy/restart ใหม่
> หากต้องการให้ความจำอยู่ถาวรควรใช้ persistent disk หรือฐานข้อมูลภายนอกในขั้นถัดไป

นอกจาก slash command ยังแท็ก `@บอท คำถาม` หรือ Direct Message หาบอทได้เลย

## สิ่งที่ต้องมี

1. **DISCORD_TOKEN** — จาก https://discord.com/developers/applications
2. **OPENROUTER_API_KEY** — จาก https://openrouter.ai/keys (มีโมเดลฟรีให้ใช้)
3. บัญชี GitHub + Render.com (deploy ฟรี)

## Deploy บน Render (ไม่ต้องมีคอม ใช้ iPhone ได้)

1. อัปโหลดไฟล์ทั้งหมดของโปรเจกต์นี้ไป GitHub repository ของคุณ (public)
2. ที่ render.com → New + → Blueprint → เลือก repo → Apply
   (ไฟล์ `render.yaml` จะตั้งค่าให้เอง)
3. ไปที่ Environment ของ service แล้วใส่ `DISCORD_TOKEN` และ `OPENROUTER_API_KEY`
   จากนั้นกด Save — บอทจะออนไลน์ภายใน 1-2 นาที
4. เช็คหน้า Logs ว่ามีบรรทัด `[bot] logged in as ...` = สำเร็จ
5. สร้าง monitor ฟรีที่ UptimeRobot กดเรียก URL `/health` ทุก 5 นาที
   เพื่อไม่ให้ Render พักการทำงานของบอท

ดูขั้นตอนละเอียดแบบมือใหม่ทุกปุ่ม ในไฟล์คู่มือ PDF ภาษาไทยที่แถมมาให้

## รันในเครื่องเอง (ถ้ามีคอม)

```bash
npm install
cp env.example .env   # แล้วแก้ค่า token/key ในไฟล์ .env
npm start
```

> หมายเหตุ: `.env` ต้องตั้งค่าเอง เพราะโค้ดอ่านค่าจาก environment variables
> (ถ้าอยากใช้ .env จริง ๆ ให้เพิ่ม `require('dotenv').config()` ต้นไฟล์ก่อน แล้ว `npm i dotenv`)

## ข้อจำกัดของแพ็กเกจฟรี

- โมเดลฟรีของ OpenRouter มีโควตาจำกัดต่อวัน ถ้าเจอข้อความ rate limit ให้เปลี่ยนโมเดลด้วย `/model`
- รูปจาก Pollinations อาจใช้เวลา 10-60 วินาทีต่อรูป
- Render free tier อาจพักการทำงานถ้าไม่มีใครเรียก `/health` (แก้ด้วย UptimeRobot ตามขั้นตอนในคู่มือ)
- ความจำบทสนทนาเก็บใน RAM — ถ้าบอทรีสตาร์ท ความจำจะเริ่มใหม่
- คลังเอกสารใช้ไฟล์ JSON; บน Render Free อาจไม่อยู่รอดหลัง deploy ใหม่จนกว่าจะตั้ง persistent storage

## License

MIT
