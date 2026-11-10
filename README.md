# Discord AI Agent — Multi-Agent System

บอท Discord หนึ่งตัว (หนึ่ง Gateway connection) ที่มี **ทีม AI หลายโมเดล** ทำงานร่วมกันอัตโนมัติ พร้อมความจำเอกสาร PDF, ความจำการสนทนารายช่อง, ค้นเว็บ และสร้างภาพ

## สถาปัตยกรรม

```
Discord Gateway (discord.js — 1 connection)
   └─ /ask (คำถามซับซ้อน หรือ workflow: true)
        🧠 Supervisor  — วิเคราะห์คำถาม วางแผนงาน
             ├─ 🔍 Research Agent (โมเดล A)      ┐ ทำงานคู่ขนาน (Promise.all)
             └─ 📊 Data Analysis Agent (โมเดล B)  ┘
        🧐 Reviewer (โมเดล C) — ตรวจ conflict / ข้อมูลผิด / คำถามที่ยังไม่ตอบ
        🧠 Supervisor — รวมเป็นคำตอบเดียว → 1 ข้อความใน Discord
```

- **หนึ่ง Gateway หลายโมเดลได้**: ทุก agent เรียกผ่าน adapter เดียว (`src/providers.js`) ไปที่ OpenRouter — เลือกโมเดลต่างกันต่อ agent ด้วย env
- Worker agent **ไม่เขียนข้อความลง Discord เอง** — มีแต่ orchestrator ที่ส่งคำตอบสุดท้ายเดียว
- ทุก agent call มี timeout / token cap / budget guard และ **fallback**: agent ใดล้ม ระบบยังตอบได้ (ไม่เกิด "Application did not respond")
- `/ask` คำถามเรียบง่าย = ตอบตรง (โมเดลเดียวเร็ว ๆ) · คำถามซับซ้อน = ทีมอัตโนมัติ (วิเคราะห์ด้วย heuristic: ความยาว + คำสำคัญ วิเคราะห์/เปรียบเทียบ/แผน/ความเสี่ยง ฯลฯ) · บังคับทีมด้วย `workflow: true`

## คำสั่ง

| คำสั่ง | คำอธิบาย |
|---|---|
| `/ask question [web] [workflow]` | ถามอะไรก็ได้ — ซับซ้อน = ทีม Multi-Agent อัตโนมัติ |
| `/research topic` | Research Agent ค้นเว็บ + สรุปพร้อมแหล่งอ้างอิง |
| `/analyze request` | Data Analysis Agent วิเคราะห์แบบมีโครงสร้าง |
| `/pdf file [question]` | ให้บอทจำ PDF (Postgres/JSON) แล้วถาม-ตอบได้ |
| `/files` · `/forget file_name` | ดู/ลบเอกสารที่จำ |
| `/image prompt` | สร้างภาพ (Pollinations) |
| `/reset` | ล้างความจำการสนทนาของช่องนั้น |
| `/status` | สถานะระบบ, โมเดลราย agent, สถิติการทำงาน |
| `/model [model_id]` | ดู/ตั้งโมเดลหลัก (เจ้าของเซิร์ฟเวอร์เท่านั้น) |
| `/help` | คำแนะนำการใช้งานใน Discord |

## ตัวแปร environment

| ตัวแปร | ค่าเริ่มต้น | หมายเหตุ |
|---|---|---|
| `DISCORD_TOKEN` | — | **จำเป็น** (รองรับ `DISCORD_BOT_TOKEN` ด้วย) |
| `OPENROUTER_API_KEY` | — | คีย์ OpenRouter — ใช้หลายโมเดลในคีย์เดียว (production) |
| `PROVIDER` | auto | `openrouter` \| `zai` \| `mock` |
| `DEFAULT_MODEL` | `openrouter/auto` | โมเดลหลักของ agent ที่ไม่ได้ระบุเอง |
| `SUPERVISOR_MODEL` `RESEARCH_MODEL` `ANALYSIS_MODEL` `REVIEWER_MODEL` | ตาม DEFAULT | ตั้งต่างกันเพื่อ "หลายโมเดลร่วมทีม" เช่น `RESEARCH_MODEL=perplexity/sonar` (มี web search ในตัว) |
| `SEARCH_PROVIDER` | auto | `zai` \| `html` (Bing→DDG) \| `off` |
| `DATABASE_URL` | — | Postgres (Render) — ไม่มีก็ใช้ไฟล์ JSON ใน `DATA_DIR` |
| `AGENT_TIMEOUT_MS` / `MAX_AGENT_TOKENS` / `MAX_WORKFLOW_CALLS` | 45000 / 1200 / 7 | ตัวกันงานค้างและงานบานพุ่ง |
| `GUILD_ID` `OWNER_ID` `CLIENT_ID` | — | ใช้ลงคำสั่งแบบ guild (instant) และตรวจสิทธิ์เจ้าของ |
| `NOTIFY_CHANNEL_ID` | — | ส่งข้อความ "ออนไลน์" เมื่อบอทพร้อม |

รายการโมเดลที่ใช้ได้: <https://openrouter.ai/models> (เช่น `openai/gpt-4o-mini`, `perplexity/sonar`, `deepseek/deepseek-chat`, `openrouter/auto`)

## รันทดสอบในเครื่อง

```bash
npm install
npm test              # 14 unit/e2e tests (mock provider — ไม่ใช้ network)
npm run simulate      # ทดสอบ /ask ทีม Multi-Agent แบบเต็มรูปแบบ (LLM จริง + ค้นเว็บจริง)
DISCORD_TOKEN=... node index.js   # รันบอทจริง
```

## ความปลอดภัย

- ใช้ **Bot API + Gateway ทางการ** เท่านั้น (ไม่ใช่ self-bot) — slash commands ทั้งหมด
- **ยังไม่มีคำสั่งทำลาย Discord** (ลบข้อความ/แก้ role/จัดการสมาชิก) — เมื่อจะเพิ่ม ต้องผ่านประตูอนุมัติเจ้าของ (`src/safety.js`)
- ไม่ log token / API key / interaction token หรือเนื้อหาเอกสารเต็ม ๆ ลง console
- **ห้ามตั้ง "Interactions Endpoint URL" ใน Discord Developer Portal** — บอทใช้ Gateway ของ discord.js; เซิร์ฟเวอร์ HTTP มีไว้เพื่อ health check ของ Render (`/health`) เท่านั้น
- `.env.example` เป็นเทมเพลต — อย่า commit ค่าจริง (`DATABASE_URL`, token, key อยู่ใน Render Environment)

## โครงสร้างไฟล์หลัก

```
index.js                  เริ่ม health server → Gateway login → ลงคำสั่ง → route interaction
src/orchestrator.js       Multi-Agent workflow (แผน → ทีมคู่ขนาน → ตรวจ → สังเคราะห์) + heuristic
src/providers.js          LLM adapter เดียว (OpenRouter / zai / mock) + timeout + stats
src/commands.js           นิยาม slash commands ทั้ง 11 + ลงทะเบียน (guild ก่อน global)
src/handlers.js           logic รายคำสั่ง + defer/แจ้งความคืบหน้า + chunk ข้อความยาว
src/document-store.js     ความจำเอกสาร (Postgres หรือ JSON) + ค้นเอกสารที่เกี่ยวข้อง
src/websearch.js          ค้นเว็บ zai → Bing → DuckDuckGo (fallback chain)
src/pdf.js  src/memory.js  src/imagegen.js  src/textutil.js  src/safety.js  src/config.js  src/stats.js
test/run-tests.js         ชุดทดสอบ 14 เคส
scripts/simulate-ask.js   จำลอง /ask, /research แบบเต็มระบบ
```

ดูวิธี deploy บน Render: [DEPLOY.md](DEPLOY.md)
