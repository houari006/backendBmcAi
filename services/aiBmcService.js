import fetch from "node-fetch";
import { openDb } from "../database.js";
import { BMC_SECTIONS } from "../config/bmcSections.js";
import dotenv from "dotenv";
dotenv.config();

async function getSessionAnswers(session_id) {
  const db = await openDb();
  const rows = await db.all(
    "SELECT section, question, answer FROM bmc_answers WHERE session_id = ?",
    [session_id]
  );
  return rows;
}

export async function generateNextQuestion(session_id) {
  const db = await openDb();
  const session = await db.get("SELECT * FROM bmc_sessions WHERE id = ?", [session_id]);
  if (!session) throw new Error("Session not found");

  const answers = await getSessionAnswers(session_id);
  const context = answers.map(a => `- ${a.section}: ${a.answer}`).join("\n");

  const prompt = `
أنت مساعد ذكي لمساعدة الطلاب في بناء نموذج BMC.
المشروع: ${session.project_title || "غير محدد"}
الإجابات السابقة:
${context || "(لا توجد إجابات بعد)"}

اقترح سؤالًا جديدًا مناسبًا للمرحلة التالية، بصيغة JSON فقط:
{
  "question": "السؤال التالي",
  "section_key": "<section_key>"
}
`;

  const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "openai/gpt-oss-120b",
      messages: [{ role: "user", content: prompt }]
    })
  });

  const data = await resp.json();
  let responseText = data.choices?.[0]?.message?.content || "";
  let parsed;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    parsed = { question: "ما هو اسم مشروعك؟", section_key: "value" };
  }
  return parsed;
}

export async function produceFinalSummary(session_id) {
  const answers = await getSessionAnswers(session_id);
  const db = await openDb();
  const session = await db.get("SELECT * FROM bmc_sessions WHERE id = ?", [session_id]);

  const context = answers.map(a => `- ${a.section}: ${a.answer}`).join("\n");

  const prompt = `
الطالب: ${session.student_name}
المشروع: ${session.project_title}
الإجابات:
${context}

أعد صياغة نموذج BMC منظم بالعربية مع كل قسم وعناصره.
`;

  const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "openai/gpt-oss-120b",
      messages: [{ role: "user", content: prompt }]
    })
  });

  const data = await resp.json();
  return data.choices?.[0]?.message?.content || "تعذر إنشاء الملخص.";
}
