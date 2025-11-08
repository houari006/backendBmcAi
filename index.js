// ===================================================
// 🌐 IMPORTS & INITIAL SETUP
// ===================================================
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import fs from "fs";
import multer from "multer";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

// ✅ استبدل GROQ بـ Gemini
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

const app = express();
app.use(cors());
app.use(bodyParser.json());
const PORT = process.env.PORT || 5000;
const SECRET_KEY = process.env.SECRET_KEY || "mysecretkey";

// ===================================================
// 🧠 إعداد الذكاء الاصطناعي (GEMINI) مع تحسينات
// ===================================================
const genAI = new GoogleGenerativeAI("AIzaSyB0yOVqdAXJ9H_sGMbXfIP12ozXtvYDfvY");
const model = genAI.getGenerativeModel({ 
  model: "gemini-2.0-flash",
  generationConfig: {
    maxOutputTokens: 1000,
    temperature: 0.7,
  }
});

// ⬇️ دالة محسنة للتعامل مع طلبات AI مع retry
async function generateContentWithRetry(prompt, maxRetries = 3) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`🔄 محاولة ${attempt} للطلب AI...`);
      
      const result = await model.generateContent(prompt);
      const response = await result.response;
      
      console.log("✅ تم استلام الرد من AI بنجاح");
      return response.text();
      
    } catch (error) {
      lastError = error;
      console.error(`❌ فشل المحاولة ${attempt}:`, error.message);
      
      if (error.status === 429) {
        // إذا كان الخطأ 429، ننتظر وقتاً أطول بين المحاولات
        const waitTime = attempt * 2000; // 2, 4, 6 ثواني
        console.log(`⏳ انتظر ${waitTime}ms قبل المحاولة التالية...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      } else {
        // لأخطاء أخرى، نكسر الحلقة
        break;
      }
    }
  }
  
  throw lastError;
}

// ===================================================
// 🧱 إنشاء قاعدة البيانات
// ===================================================
async function openDb() {
  return open({
    filename: "./database.sqlite",
    driver: sqlite3.Database,
  });
}

async function createTables() {
  const db = await openDb();
  await db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      email TEXT UNIQUE,
      password TEXT
    )
  `);
  await db.run(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_name TEXT,
      project_title TEXT,
      description TEXT,
      phone TEXT,
      logo TEXT,
      pdf_file TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // جدول جديد لتخزين التصميمات
  await db.run(`
    CREATE TABLE IF NOT EXISTS designs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT,
      design_type TEXT,
      design_data TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
}
await createTables();

// ===================================================
// 🔐 AUTH MIDDLEWARE
// ===================================================
function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(403).json({ message: "No token provided" });

  const token = authHeader.split(" ")[1];
  jwt.verify(token, SECRET_KEY, (err, decoded) => {
    if (err) return res.status(401).json({ message: "Invalid token" });
    req.user = decoded;
    next();
  });
}

// ===================================================
// 🤖 AI SESSIONS - محسّن مع دعم التصميم
// ===================================================
let sessions = {};
const BMC_SECTIONS = [
  "Key Partners", "Key Activities", "Value Propositions",
  "Customer Relationships", "Customer Segments", "Key Resources",
  "Channels", "Cost Structure", "Revenue Streams",
];

// ⬇️ توليد السؤال التالي في BMC مع fallback
async function generateNextQuestion(sessionId) {
  const section = BMC_SECTIONS[(sessions[sessionId]?.bmcProgress || 0) % BMC_SECTIONS.length];
  
  const sectionNames = {
    "Key Partners": "الشركاء الرئيسيون",
    "Key Activities": "الأنشطة الرئيسية", 
    "Value Propositions": "القيمة المقدمة",
    "Customer Relationships": "علاقات العملاء",
    "Customer Segments": "شرائح العملاء",
    "Key Resources": "الموارد الرئيسية",
    "Channels": "قنوات التوزيع",
    "Cost Structure": "هيكل التكاليف",
    "Revenue Streams": "تدفقات الإيرادات"
  };

  const arabicSection = sectionNames[section] || section;
  
  const prompt = `
أنت مستشار لمشاريع طلاب حاضنة أعمال 3win في مركز جامعي مغنية.
قسم النموذج الحالي: "${arabicSection}".
اكتب سؤالاً واحداً باللغة العربية لتوجيه الطالب في هذا القسم.
يجب أن يكون السؤال واضحاً ومباشراً ويتعلق بـ ${arabicSection}.
`;

  try {
    const aiMessage = await generateContentWithRetry(prompt);
    
    if (!sessions[sessionId]) sessions[sessionId] = { chat: [], mode: "bmc" };
    sessions[sessionId].chat.push({ role: "assistant", content: aiMessage });
    return aiMessage;
    
  } catch (error) {
    console.error("Error generating BMC question:", error);
    
    // Fallback questions in case AI fails
    const fallbackQuestions = {
      "Key Partners": "من هم الشركاء الرئيسيون الذين تحتاجهم لتنفيذ مشروعك؟",
      "Key Activities": "ما هي الأنشطة الرئيسية التي يجب القيام بها لتقديم قيمة للعملاء؟",
      "Value Propositions": "ما هي القيمة المميزة التي يقدمها مشروعك للعملاء؟",
      "Customer Relationships": "كيف ستبني وتحافظ على علاقات مع عملائك؟",
      "Customer Segments": "من هم العملاء المستهدفون لمشروعك؟",
      "Key Resources": "ما هي الموارد الرئيسية التي تحتاجها لتشغيل المشروع؟",
      "Channels": "كيف ستصل إلى عملائك وتقدم لهم خدماتك؟",
      "Cost Structure": "ما هي التكاليف الرئيسية التي ستتحملها في مشروعك؟",
      "Revenue Streams": "كيف ستحقق الإيرادات من مشروعك؟"
    };
    
    const fallbackMessage = fallbackQuestions[section] || "أخبرني المزيد عن هذا الجانب من مشروعك.";
    
    if (!sessions[sessionId]) sessions[sessionId] = { chat: [], mode: "bmc" };
    sessions[sessionId].chat.push({ role: "assistant", content: fallbackMessage });
    return fallbackMessage;
  }
}

// ⬇️ إنتاج ملخص نهائي مع fallback
async function produceFinalSummary(sessionId) {
  const bmcData = sessions[sessionId]?.bmcData || {};
  
  if (Object.keys(bmcData).length === 0) {
    return "⚠️ لم يتم جمع بيانات كافية لتوليد ملخص. يرجى إكمال المزيد من الأسئلة.";
  }

  const prompt = `
قم بإنشاء ملخص واضح وشامل باللغة العربية لنموذج العمل التجاري للطالب بناءً على البيانات التالية:
${JSON.stringify(bmcData, null, 2)}

الملخص يجب أن:
- يكون باللغة العربية
- يكون منظماً وواضحاً
- يسلط الضوء على النقاط الرئيسية
- يعطي نظرة شاملة عن نموذج العمل
`;

  try {
    const summary = await generateContentWithRetry(prompt);
    return summary;
  } catch (error) {
    console.error("Error generating summary:", error);
    
    // Fallback summary
    return `📊 **ملخص نموذج العمل التجاري**

بناءً على البيانات المقدمة، إليك نظرة عامة على نموذج عملك:

${Object.entries(bmcData).map(([section, answer]) => 
  `**${section}:** ${answer}`
).join('\n\n')}

💡 **نصيحة:** يمكنك تحسين نموذج عملك من خلال التركيز على تناسق جميع الأقسام مع بعضها البعض.`;
  }
}

// ⬇️ وظيفة مساعدة في إنشاء التصميم مع دعم المحادثة الحرة
async function handleDesignAssistant(sessionId, userMessage) {
  if (!sessions[sessionId]) {
    sessions[sessionId] = { 
      chat: [], 
      mode: "design",
      bmcData: {},
      bmcProgress: 0 
    };
  }

  // إضافة سؤال المستخدم إلى السجل
  sessions[sessionId].chat.push({ role: "user", content: userMessage });

  // تحديد نوع المساعدة المطلوبة
  const lowerMessage = userMessage.toLowerCase();
  
  let designContext = "عام";
  if (lowerMessage.includes('شعار') || lowerMessage.includes('لوجو')) {
    designContext = "تصميم الشعار";
  } else if (lowerMessage.includes('موقع') || lowerMessage.includes('ويب')) {
    designContext = "تصميم الموقع الإلكتروني";
  } else if (lowerMessage.includes('هوية') || lowerMessage.includes('براند')) {
    designContext = "الهوية البصرية";
  } else if (lowerMessage.includes('غلاف') || lowerMessage.includes('كتاب')) {
    designContext = "تصميم الغلاف";
  } else if (lowerMessage.includes('منشور') || lowerMessage.includes('سوشيال')) {
    designContext = "تصميم منشورات وسائل التواصل";
  } else if (lowerMessage.includes('عرض') || lowerMessage.includes('عروض')) {
    designContext = "تصميم العروض التقديمية";
  }

  const prompt = `
أنت مساعد ذكي متخصص في التصميم الجرافيكي وتطوير المشاريع لطلاب حاضنة أعمال 3win.
المجال: ${designContext}
سؤال الطالب: "${userMessage}"

قم بتقديم المساعدة في:
1. نصائح تصميمية عملية
2. أفكار إبداعية مناسبة للمشاريع الناشئة
3. توجهات حول الألوان والخطوط والتخطيط
4. اقتراحات tools وبرامج مفيدة
5. أفضل الممارسات في التصميم

إذا كان السؤال ليس عن التصميم، قدم إجابة مفيدة في مجال ريادة الأعمال وتطوير المشاريع.

أجب باللغة العربية بطريقة:
- مهنية وإبداعية
- عملية وقابلة للتطبيق
- مراعية لميزانية الطلاب
- تشجع الإبداع والابتكار

الإجابة:
`;

  try {
    const aiResponse = await generateContentWithRetry(prompt);
    
    // حفظ رد المساعد في السجل
    sessions[sessionId].chat.push({ role: "assistant", content: aiResponse });
    
    return aiResponse;
    
  } catch (error) {
    console.error("AI Error in design assistant:", error);
    
    // Fallback responses للتصميم
    let fallbackResponse = "🎨 **مساعد التصميم الإبداعي**\n\n";
    
    if (designContext !== "عام") {
      fallbackResponse += `في مجال ${designContext}، أنصحك بـ:\n\n`;
    }
    
    if (designContext === "تصميم الشعار") {
      fallbackResponse += "• اختر ألواناً تعبر عن هوية مشروعك\n• استخدم خطوطاً واضحة وسهلة القراءة\n• اجعل الشعار بسيطاً وقابلاً للتذكر\n• تأكد من وضوح الشعار بمختلف الأحجام\n• فكر في القيمة التي يقدمها مشروعك";
    } else if (designContext === "تصميم الموقع الإلكتروني") {
      fallbackResponse += "• ركز على تجربة المستخدم البسيطة\n• استخدم ألواناً متناسقة مع الهوية\n• اجعل الموقع سريع التحميل\n• تأكد من توافقه مع الجوال\n• استخدم صوراً عالية الجودة";
    } else if (designContext === "الهوية البصرية") {
      fallbackResponse += "• حدد لوحة ألوان ثابتة\n• اختر خطوطاً متناسقة\n• أنشئ دليل هوية مرئية\n• حافظ على الاتساق في جميع المواد\n• فكر في جمهورك المستهدف";
    } else {
      fallbackResponse += "يمكنني مساعدتك في:\n\n• تصميم الشعار والهوية البصرية\n• تصميم المواقع والتطبيقات\n• تصميم العروض التقديمية\n• تصميم منشورات وسائل التواصل\n• نصائح الألوان والخطوط\n• أدوات التصميم المجانية\n\nما هو نوع التصميم الذي تحتاجه؟";
    }
    
    fallbackResponse += "\n\n💡 *يمكنك استخدام أدوات مثل: Canva, Figma, Adobe Express للبدء*";
    
    sessions[sessionId].chat.push({ role: "assistant", content: fallbackResponse });
    return fallbackResponse;
  }
}

// ⬇️ وظيفة متقدمة لإنشاء تصاميم مقترحة
async function generateDesignSuggestions(sessionId, projectType) {
  const prompt = `
أنت مصمم جرافيكي محترف تقدم استشارات لطلاب حاضنة أعمال 3win.
نوع المشروع: ${projectType}

قدم 3 اقتراحات تصميمية إبداعية تشمل:
1. لوحة ألوان مناسبة
2. نمط تصميم مقترح
3. نصائح typography
4. أفكار إبداعية للهوية
5. أدوات مجانية مقترحة

أجب باللغة العربية بطريقة إبداعية ومحفزة.
`;

  try {
    const suggestions = await generateContentWithRetry(prompt);
    return suggestions;
  } catch (error) {
    console.error("Error generating design suggestions:", error);
    
    return `🎯 **اقتراحات تصميمية لـ ${projectType}**

1. **النمط البسيط والحديث**
   - الألوان: أزرق مهني + أبيض + رمادي
   - الخطوط: sans-serif واضحة
   - ركز على البساطة والوضوح

2. **النمط الإبداعي الجريء**
   - الألوان: ألوان زاهية ومتناقضة
   - الخطوط: مزيج بين classic وmodern
   - شجع على الإبداع والتميز

3. **النمط الاحترافي التقليدي**
   - الألوان: درجات محايدة واحترافية
   - الخطوط: serif كلاسيكية
   - يناسب المشاريع التقليدية

🛠️ **أدوات مجانية**: Canva, Figma, Adobe Color, Google Fonts`;
  }
}

// ===================================================
// 🚀 API ROUTES مع تحسين التعامل مع الأخطاء
// ===================================================

// 🧩 Auth (بدون تغيير)
app.post("/api/auth/register", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ message: "All fields required" });

  try {
    const db = await openDb();
    const hashedPassword = await bcrypt.hash(password, 10);
    await db.run(`INSERT INTO users (name, email, password) VALUES (?, ?, ?)`, [
      name,
      email,
      hashedPassword,
    ]);
    res.status(201).json({ message: "✅ User registered successfully" });
  } catch (error) {
    if (error.message.includes("UNIQUE"))
      return res.status(400).json({ message: "Email already exists" });
    res.status(500).json({ message: "Server error" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ message: "Email and password required" });

  try {
    const db = await openDb();
    const user = await db.get(`SELECT * FROM users WHERE email = ?`, [email]);
    if (!user) return res.status(404).json({ message: "User not found" });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ message: "Invalid password" });

    const token = jwt.sign({ id: user.id, email: user.email }, SECRET_KEY, { expiresIn: "2h" });
    res.json({ message: "✅ Login successful", token });
  } catch {
    res.status(500).json({ message: "Server error" });
  }
});

// 🧠 BMC Routes مع تحسين الأخطاء
app.post("/api/start", (req, res) => {
  const { studentId } = req.body;
  sessions[studentId] = { 
    bmcData: {}, 
    chat: [], 
    bmcProgress: 0,
    mode: "bmc",
    createdAt: new Date()
  };
  res.json({ message: "Session started", studentId });
});

app.post("/api/next", async (req, res) => {
  const { studentId } = req.body;
  
  if (!sessions[studentId]) {
    return res.status(400).json({ error: "No active session found" });
  }

  try {
    const question = await generateNextQuestion(studentId);
    res.json({ 
      question,
      progress: sessions[studentId].bmcProgress,
      totalSections: BMC_SECTIONS.length
    });
  } catch (err) {
    console.error("Error in /api/next:", err);
    res.status(500).json({ error: "Failed to generate question" });
  }
});

app.post("/api/answer", (req, res) => {
  const { studentId, answer } = req.body;
  if (!sessions[studentId]) return res.status(400).json({ error: "No session found" });

  sessions[studentId].chat.push({ role: "user", content: answer });
  
  // إذا كان في وضع BMC، تقدم في التقدم
  if (sessions[studentId].mode === "bmc") {
    const currentSectionIndex = sessions[studentId].bmcProgress % BMC_SECTIONS.length;
    const currentSection = BMC_SECTIONS[currentSectionIndex];
    sessions[studentId].bmcData[currentSection] = answer;
    sessions[studentId].bmcProgress += 1;
  }
  
  res.json({ 
    message: "Answer saved",
    progress: sessions[studentId].bmcProgress,
    totalSections: BMC_SECTIONS.length
  });
});

app.post("/api/summary", async (req, res) => {
  const { studentId } = req.body;
  
  if (!sessions[studentId]) {
    return res.status(400).json({ error: "No active session found" });
  }

  try {
    const summary = await produceFinalSummary(studentId);
    res.json({ 
      summary,
      bmcData: sessions[studentId].bmcData
    });
  } catch (err) {
    console.error("Error in /api/summary:", err);
    res.status(500).json({ error: "Failed to generate summary" });
  }
});

// 🆕 مسار مساعد التصميم (بدل المحادثة الحرة)
app.post("/api/chat", async (req, res) => {
  const { studentId, message } = req.body;
  
  if (!studentId || !message) {
    return res.status(400).json({ error: "Student ID and message are required" });
  }

  try {
    const response = await handleDesignAssistant(studentId, message);
    res.json({ 
      response,
      mode: sessions[studentId]?.mode || "design"
    });
  } catch (err) {
    console.error("Error in /api/chat:", err);
    res.status(500).json({ error: "Failed to process message" });
  }
});

// 🆕 مسار خاص لاقتراحات التصميم
app.post("/api/design/suggestions", async (req, res) => {
  const { studentId, projectType } = req.body;
  
  if (!studentId || !projectType) {
    return res.status(400).json({ error: "Student ID and project type are required" });
  }

  try {
    const suggestions = await generateDesignSuggestions(studentId, projectType);
    res.json({ 
      suggestions,
      projectType
    });
  } catch (err) {
    console.error("Error in /api/design/suggestions:", err);
    res.status(500).json({ error: "Failed to generate design suggestions" });
  }
});

// 🆕 مسار لحفظ التصميمات
app.post("/api/design/save", async (req, res) => {
  const { studentId, designType, designData } = req.body;
  
  if (!studentId || !designType) {
    return res.status(400).json({ error: "Student ID and design type are required" });
  }

  try {
    const db = await openDb();
    await db.run(
      `INSERT INTO designs (student_id, design_type, design_data) VALUES (?, ?, ?)`,
      [studentId, designType, designData || '']
    );
    res.json({ message: "✅ Design saved successfully" });
  } catch (err) {
    console.error("Error saving design:", err);
    res.status(500).json({ error: "Failed to save design" });
  }
});

// 🆕 مسار لجلب التصميمات المحفوظة
app.get("/api/designs/:studentId", async (req, res) => {
  const { studentId } = req.params;
  
  try {
    const db = await openDb();
    const designs = await db.all(
      "SELECT * FROM designs WHERE student_id = ? ORDER BY created_at DESC",
      [studentId]
    );
    res.json({ designs });
  } catch (err) {
    console.error("Error fetching designs:", err);
    res.status(500).json({ error: "Failed to fetch designs" });
  }
});

// 🆕 مسار للحصول على تاريخ المحادثة
app.get("/api/chat/history/:studentId", (req, res) => {
  const { studentId } = req.params;
  const session = sessions[studentId];
  
  if (!session) {
    return res.json({ history: [] });
  }
  
  res.json({ 
    history: session.chat,
    mode: session.mode,
    bmcProgress: session.bmcProgress,
    bmcData: session.bmcData
  });
});

// 🆕 مسار للتبديل بين وضع BMC ومساعد التصميم
app.post("/api/mode/switch", (req, res) => {
  const { studentId, mode } = req.body;
  
  if (!sessions[studentId]) {
    sessions[studentId] = { 
      chat: [], 
      bmcData: {}, 
      bmcProgress: 0,
      createdAt: new Date()
    };
  }
  
  sessions[studentId].mode = mode;
  
  // إضافة رسالة ترحيب حسب الوضع
  if (mode === "design" && sessions[studentId].chat.length === 0) {
    sessions[studentId].chat.push({
      role: "assistant",
      content: "🎨 **مرحباً! أنا مساعدك في التصميم الإبداعي**\n\nيمكنني مساعدتك في:\n• تصميم الشعار والهوية البصرية\n• نصائح الألوان والخطوط\n• تصميم المواقع والعروض التقديمية\n• أدوات التصميم المجانية\n\nما هو التصميم الذي تريد المساعدة فيه؟"
    });
  }
  
  res.json({ 
    message: `Mode switched to ${mode}`,
    mode: mode
  });
});

// 🆕 مسار لفحص حالة الخادم
app.get("/api/health", (req, res) => {
  res.json({
    status: "✅ Server is running",
    timestamp: new Date().toISOString(),
    activeSessions: Object.keys(sessions).length,
    geminiStatus: "Configured",
    features: ["BMC Assistant", "Design Assistant", "Authentication", "File Upload"]
  });
});

// 🆕 تنظيف الجلسات القديمة تلقائياً
setInterval(() => {
  const now = new Date();
  const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
  
  let cleanedCount = 0;
  Object.keys(sessions).forEach(sessionId => {
    if (sessions[sessionId].createdAt < twoHoursAgo) {
      delete sessions[sessionId];
      cleanedCount++;
    }
  });
  
  if (cleanedCount > 0) {
    console.log(`🧹 تم تنظيف ${cleanedCount} جلسة منتهية الصلاحية`);
  }
}, 30 * 60 * 1000); // كل 30 دقيقة

// ===================================================
// 🧩 PROJECT CRUD (بدون تغيير)
// ===================================================
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname),
});
const upload = multer({ storage });

app.post(
  "/api/projects",
  verifyToken,
  upload.fields([{ name: "logo", maxCount: 1 }, { name: "pdf_file", maxCount: 1 }]),
  async (req, res) => {
    const { student_name, project_title, description, phone } = req.body;
    const logo = req.files?.logo ? req.files.logo[0].path : null;
    const pdf_file = req.files?.pdf_file ? req.files.pdf_file[0].path : null;

    try {
      const db = await openDb();
      await db.run(
        `INSERT INTO projects (student_name, project_title, description, phone, logo, pdf_file)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [student_name, project_title, description, phone, logo, pdf_file]
      );
      res.status(201).json({ message: "✅ Project saved" });
    } catch {
      res.status(500).json({ message: "Error saving project" });
    }
  }
);

app.get("/api/projects", async (req, res) => {
  try {
    const db = await openDb();
    const projects = await db.all("SELECT * FROM projects ORDER BY created_at DESC");
    res.json(projects);
  } catch {
    res.status(500).json({ message: "Error fetching projects" });
  }
});

// ===================================================
// 🔥 START SERVER
// ===================================================
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
  console.log(`🤖 AI Assistant ready for BMC sessions and Design help`);
  console.log(`🎨 Design Assistant activated with creative support`);
  console.log(`🔧 Health check available at http://localhost:${PORT}/api/health`);
});