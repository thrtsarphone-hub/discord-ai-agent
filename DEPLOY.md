# คู่มือ Deploy บน Render (ฉบับย่อ)

ระบบนี้แทนที่โค้ดเดิมใน repo `thrtsarphone-hub/discord-ai-agent` ได้ทันที — ยังใช้ env เดิม (`DISCORD_TOKEN`, `OPENROUTER_API_KEY`, `DEFAULT_MODEL`, `DATABASE_URL`) และคำสั่งเดิมทั้งหมด บวก Multi-Agent workflow ใหม่

## ขั้นตอน (กรณีมี Render service อยู่แล้วเหมือนของคุณ)

1. **วางโค้ดใหม่แทนโค้ดเก่าใน repo**
   ```bash
   git clone https://github.com/thrtsarphone-hub/discord-ai-agent
   cd discord-ai-agent
   # ลบไฟล์เก่าออกก่อน (เช่น index.js, document-store.js เดิม) แล้ววางไฟล์ทั้งหมดจากแพ็กเกจนี้ทับ
   git add -A
   git commit -m "Multi-agent upgrade: Supervisor -> Research + Analysis -> Reviewer -> Synthesis"
   git push origin main
   ```
   Render จะ auto-deploy จาก branch `main` ให้อัตโนมัติ

2. **ตั้ง env เพิ่มใน Render (Environment ของ service)** — อันมีอยู่แล้วไม่ต้องแตะ:
   - มีอยู่แล้ว: `DISCORD_TOKEN`, `OPENROUTER_API_KEY`, `DATABASE_URL` (ถ้ามี Postgres)
   - แนะนำเพิ่ม: `GUILD_ID=1567043769860104322`, `OWNER_ID=670550091953733632`, `CLIENT_ID=1567044332664520744` (ทำให้คำสั่งลงแบบ guild = ใช้ได้ทันที และ /model ตรวจสิทธิ์เจ้าของได้)
   - ถ้าอยากให้แต่ละ agent ใช้โมเดลต่างกัน (แต่ตั้งหรือไม่ก็ได้): `SUPERVISOR_MODEL`, `RESEARCH_MODEL`, `ANALYSIS_MODEL`, `REVIEWER_MODEL` — ดูรายการที่ https://openrouter.ai/models

3. **ตรวจสอบหลัง deploy**
   - เปิด `https://<service>.onrender.com/health` → ต้องตอบ `OK — bot is running (gateway: ready...)`
   - ใน Discord พิมพ์ `/status` → เห็น provider `openrouter` และโมเดลราย agent
   - ทดสอบทีม: `/ask วิเคราะห์และเปรียบเทียบ X กับ Y ปี 2026 พร้อมความเสี่ยง` (คำถามซับซ้อน = ทีมอัตโนมัติ) หรือบังคับทีมด้วย `/ask ... workflow: true`

## ข้อควรระวัง / คำตอบสำหรับปัญหาที่เคยเจอ

- **"Application did not respond"** — เวอร์ชันนี้ defer ทันทีที่ได้ interaction และทุกขั้นมี fallback จึงไม่ควรเกิดอีก; ถ้าเจอ ให้ดู Render Logs ว่า Gateway login สำเร็จและ `DISCORD_TOKEN` ถูก
- **Interactions Endpoint URL** — ปล่อยว่างเสมอ! บอทใช้ discord.js Gateway ไม่ใช่ HTTP interactions (HTTP server มีไว้เฉพาะ `/health` ของ Render)
- **บอทตัวเก่าบน Render ยังเปิดอยู่** — ระหว่างที่ยังไม่ได้ push โค้ดใหม่ ถ้าเปิดสองตัวพร้อมกันอาจเห็นตอบซ้ำ 2 ข้อความ; หลัง push + auto-deploy แล้วจะเหลือตัวใหม่ตัวเดียว
- **Free plan หลับ** — ถ้าใช้ Render free tier เซอร์วิสจะ sleep เมื่อไม่มี traffic ทำให้บอทออฟไลน์ ให้ใช้บริการ ping ภายนอก (เช่น cron-job.org) ยิง `/health` ทุก 5 นาที หรืออัปเกรด plan
- **คีย์ OpenRouter ต้องมีเครดิต** — โมเดลอย่าง `openai/gpt-4o-mini` ถูกมากแต่ไม่ฟรี; ถ้าเรียกไม่ได้ `/status` จะโชว์จำนวน LLM failures เพิ่ม และคำตอบจะบอกว่า provider ยังไม่ตอบ

## สร้าง service ใหม่ (ถ้าจะทำแยก)

ใช้ `render.yaml` ในแพ็กเกจ: New → Blueprint → ชี้ repo → ตั้ง `DISCORD_TOKEN` และ `OPENROUTER_API_KEY` เป็น secret env → Deploy (start command `node index.js`, health check `/health`)
