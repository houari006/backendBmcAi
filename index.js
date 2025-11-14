// ===================================================
// 🌐 IMPORTS & INITIAL SETUP
// ===================================================
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import { GoogleGenerativeAI } from "@google/generative-ai";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";
import PDFDocument from "pdfkit";

// تحميل متغيرات البيئة
dotenv.config();

// تكوين Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || "dhfiibifo",
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const app = express();

// تكوين CORS
app.use(cors({
  origin: [
    'http://localhost:4200',
    'https://palegoldenrod-hippopotamus-154780.hostingersite.com'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
}));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const PORT = process.env.PORT || 5000;
const SECRET_KEY = process.env.SECRET_KEY || "mysecretkey";

// تكوين Gemini AI
let genAI, model;
try {
  genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "AIzaSyB0yOVqdAXJ9H_sGMbXfIP12ozXtvYDfvY");
  model = genAI.getGenerativeModel({ 
    model: "gemini-2.0-flash",
    generationConfig: {
      maxOutputTokens: 1000,
      temperature: 0.7,
    }
  });
  console.log("✅ Gemini AI configured successfully");
} catch (error) {
  console.warn("⚠️ Gemini AI configuration failed:", error.message);
}

// تكوين Multer للذاكرة
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB
  }
});

// ===================================================
// 🧠 AI HELPER FUNCTIONS
// ===================================================
async function generateContentWithRetry(prompt, maxRetries = 3) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`🔄 AI attempt ${attempt}...`);
      const result = await model.generateContent(prompt);
      const response = await result.response;
      console.log("✅ AI response received successfully");
      return response.text();
    } catch (error) {
      lastError = error;
      console.error(`❌ Attempt ${attempt} failed:`, error.message);
      
      if (error.status === 429) {
        const waitTime = attempt * 2000;
        console.log(`⏳ Waiting ${waitTime}ms before next attempt...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      } else {
        break;
      }
    }
  }
  
  throw lastError;
}

// ===================================================
// 🗄️ DATABASE SETUP
// ===================================================
async function openDb() {
  const dbPath = process.env.NODE_ENV === 'production' ? '/tmp/database.sqlite' : './database.sqlite';
  return open({
    filename: dbPath,
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
      password TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  await db.run(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_name TEXT,
      project_title TEXT,
      description TEXT,
      phone TEXT,
      logo_url TEXT,
      pdf_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  await db.run(`
    CREATE TABLE IF NOT EXISTS designs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT,
      design_type TEXT,
      design_data TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  console.log("✅ Database tables created successfully");
}

// ===================================================
// 🔐 AUTHENTICATION MIDDLEWARE
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
// ☁️ CLOUDINARY FILE UPLOAD FUNCTIONS
// ===================================================
async function uploadToCloudinary(fileBuffer, fileName, resourceType = 'auto') {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        resource_type: resourceType,
        public_id: `3win-projects/${fileName.replace(/\.[^/.]+$/, "")}`,
        folder: "3win-projects",
        overwrite: true
      },
      (error, result) => {
        if (error) {
          console.error("❌ Cloudinary upload error:", error);
          reject(error);
        } else {
          console.log(`✅ File uploaded to Cloudinary: ${result.secure_url}`);
          resolve(result);
        }
      }
    );
    
    uploadStream.end(fileBuffer);
  });
}

async function deleteFromCloudinary(publicId) {
  try {
    const result = await cloudinary.uploader.destroy(publicId);
    console.log(`✅ File deleted from Cloudinary: ${publicId}`);
    return result;
  } catch (error) {
    console.error("❌ Cloudinary delete error:", error);
    throw error;
  }
}

// ===================================================
// 🤖 AI SESSIONS MANAGEMENT
// ===================================================
let sessions = {};
const BMC_SECTIONS = [
  "Key Partners", "Key Activities", "Value Propositions",
  "Customer Relationships", "Customer Segments", "Key Resources",
  "Channels", "Cost Structure", "Revenue Streams",
];

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

async function handleDesignAssistant(sessionId, userMessage) {
  if (!sessions[sessionId]) {
    sessions[sessionId] = { 
      chat: [], 
      mode: "design",
      bmcData: {},
      bmcProgress: 0 
    };
  }

  sessions[sessionId].chat.push({ role: "user", content: userMessage });

  const lowerMessage = userMessage.toLowerCase();
  let designContext = "عام";
  
  if (lowerMessage.includes('شعار') || lowerMessage.includes('لوجو')) designContext = "تصميم الشعار";
  else if (lowerMessage.includes('موقع') || lowerMessage.includes('ويب')) designContext = "تصميم الموقع الإلكتروني";
  else if (lowerMessage.includes('هوية') || lowerMessage.includes('براند')) designContext = "الهوية البصرية";
  else if (lowerMessage.includes('غلاف') || lowerMessage.includes('كتاب')) designContext = "تصميم الغلاف";
  else if (lowerMessage.includes('منشور') || lowerMessage.includes('سوشيال')) designContext = "تصميم منشورات وسائل التواصل";
  else if (lowerMessage.includes('عرض') || lowerMessage.includes('عروض')) designContext = "تصميم العروض التقديمية";

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

أجب باللغة العربية بطريقة مهنية وإبداعية وعملية.
`;

  try {
    const aiResponse = await generateContentWithRetry(prompt);
    sessions[sessionId].chat.push({ role: "assistant", content: aiResponse });
    return aiResponse;
  } catch (error) {
    console.error("AI Error in design assistant:", error);
    
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

// ===================================================
// 🚀 API ROUTES
// ===================================================

// Health Check
app.get("/", (req, res) => {
  res.json({ 
    message: "🚀 3win Business Incubator Backend is running!",
    timestamp: new Date().toISOString(),
    version: "2.0.0",
    features: ["Cloudinary Storage", "AI Assistant", "File Management"]
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "✅ Server is running",
    timestamp: new Date().toISOString(),
    cloudinary: cloudinary.config().cloud_name ? "Configured" : "Not Configured",
    gemini: model ? "Configured" : "Not Configured",
    activeSessions: Object.keys(sessions).length
  });
});

// ===================================================
// 👥 AUTHENTICATION ROUTES
// ===================================================
app.post("/api/auth/register", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ message: "All fields required" });

  try {
    const db = await openDb();
    const hashedPassword = await bcrypt.hash(password, 10);
    await db.run(`INSERT INTO users (name, email, password) VALUES (?, ?, ?)`, [
      name, email, hashedPassword
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

// ===================================================
// 📁 PROJECT ROUTES WITH CLOUDINARY
// ===================================================
app.post(
  "/api/projects",
  verifyToken,
  upload.fields([{ name: "logo", maxCount: 1 }, { name: "pdf_file", maxCount: 1 }]),
  async (req, res) => {
    const { student_name, project_title, description, phone } = req.body;
    
    try {
      let logoUrl = null;
      let pdfUrl = null;

      // رفع Logo إلى Cloudinary
      if (req.files?.logo) {
        const logoFile = req.files.logo[0];
        const logoResult = await uploadToCloudinary(
          logoFile.buffer,
          `logo_${Date.now()}_${logoFile.originalname}`,
          'image'
        );
        logoUrl = logoResult.secure_url;
      }

      // رفع PDF إلى Cloudinary
      if (req.files?.pdf_file) {
        const pdfFile = req.files.pdf_file[0];
        const pdfResult = await uploadToCloudinary(
          pdfFile.buffer,
          `bmc_${Date.now()}_${pdfFile.originalname}`,
          'raw'
        );
        pdfUrl = pdfResult.secure_url;
      }

      const db = await openDb();
      const result = await db.run(
        `INSERT INTO projects (student_name, project_title, description, phone, logo_url, pdf_url)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [student_name, project_title, description, phone, logoUrl, pdfUrl]
      );

      res.status(201).json({ 
        message: "✅ Project saved successfully",
        projectId: result.lastID,
        logoUrl: logoUrl,
        pdfUrl: pdfUrl
      });
    } catch (error) {
      console.error("Error saving project:", error);
      res.status(500).json({ message: "Error saving project" });
    }
  }
);

// Get all projects
app.get("/api/projects", async (req, res) => {
  try {
    const db = await openDb();
    const projects = await db.all("SELECT * FROM projects ORDER BY created_at DESC");
    res.json(projects);
  } catch (error) {
    console.error("Error fetching projects:", error);
    res.status(500).json({ message: "Error fetching projects" });
  }
});

// Get single project
app.get("/api/projects/:id", async (req, res) => {
  try {
    const db = await openDb();
    const project = await db.get("SELECT * FROM projects WHERE id = ?", [req.params.id]);
    
    if (!project) {
      return res.status(404).json({ message: "Project not found" });
    }
    
    res.json(project);
  } catch (error) {
    console.error("Error fetching project:", error);
    res.status(500).json({ message: "Error fetching project" });
  }
});

// Delete project
app.delete("/api/projects/:id", async (req, res) => {
  try {
    const db = await openDb();
    
    // الحصول على المشروع أولاً لحذف الملفات من Cloudinary
    const project = await db.get("SELECT * FROM projects WHERE id = ?", [req.params.id]);
    
    if (!project) {
      return res.status(404).json({ message: "Project not found" });
    }

    // حذف الملفات من Cloudinary
    if (project.logo_url) {
      const logoPublicId = project.logo_url.split('/').pop().split('.')[0];
      await deleteFromCloudinary(`3win-projects/${logoPublicId}`);
    }
    
    if (project.pdf_url) {
      const pdfPublicId = project.pdf_url.split('/').pop().split('.')[0];
      await deleteFromCloudinary(`3win-projects/${pdfPublicId}`);
    }

    // حذف المشروع من قاعدة البيانات
    const result = await db.run("DELETE FROM projects WHERE id = ?", [req.params.id]);
    
    res.json({ message: "✅ Project deleted successfully" });
  } catch (error) {
    console.error("Error deleting project:", error);
    res.status(500).json({ message: "Error deleting project" });
  }
});

// ===================================================
// 🎨 DESIGNS ROUTES
// ===================================================
app.get("/api/designs", async (req, res) => {
  try {
    const db = await openDb();
    const designs = await db.all("SELECT * FROM designs ORDER BY created_at DESC");
    res.json(designs);
  } catch (error) {
    console.error("Error fetching designs:", error);
    res.status(500).json({ message: "Error fetching designs" });
  }
});

app.delete("/api/designs/:id", async (req, res) => {
  try {
    const db = await openDb();
    const result = await db.run("DELETE FROM designs WHERE id = ?", [req.params.id]);
    
    if (result.changes === 0) {
      return res.status(404).json({ message: "Design not found" });
    }
    
    res.json({ message: "✅ Design deleted successfully" });
  } catch (error) {
    console.error("Error deleting design:", error);
    res.status(500).json({ message: "Error deleting design" });
  }
});

// ===================================================
// 🤖 AI CHAT ROUTES
// ===================================================
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

// ===================================================
// 📁 FILE DOWNLOAD ROUTES
// ===================================================
app.get("/api/projects/:id/download/:filetype", async (req, res) => {
  const { id, filetype } = req.params;
  
  try {
    const db = await openDb();
    const project = await db.get("SELECT * FROM projects WHERE id = ?", [id]);
    
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    
    let fileUrl;
    if (filetype === 'logo') {
      fileUrl = project.logo_url;
    } else if (filetype === 'pdf') {
      fileUrl = project.pdf_url;
    } else {
      return res.status(400).json({ error: 'Invalid file type' });
    }
    
    if (!fileUrl) {
      return res.status(404).json({ error: 'File not found for this project' });
    }
    
    // إعادة التوجيه إلى رابط Cloudinary
    res.redirect(fileUrl);
    
  } catch (error) {
    console.error('Error fetching project file:', error);
    res.status(500).json({ error: 'Failed to fetch file' });
  }
});

// ===================================================
// 🚀 START SERVER
// ===================================================
async function startServer() {
  try {
    await createTables();
    
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`📍 Health check: http://localhost:${PORT}/api/health`);
      console.log(`☁️ Cloudinary: ${cloudinary.config().cloud_name ? 'Configured' : 'Not configured'}`);
      console.log(`🤖 AI Assistant: ${model ? 'Ready' : 'Not available'}`);
    });
  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
}

// تنظيف الجلسات القديمة
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
    console.log(`🧹 Cleaned ${cleanedCount} expired sessions`);
  }
}, 30 * 60 * 1000);

startServer();
