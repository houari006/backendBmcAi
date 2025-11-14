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

dotenv.config();

// ✅ تكوين Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || "dhfiibifo",
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true
});

const app = express();

// ✅ إعداد CORS
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

// ✅ تكوين Gemini AI
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

// ✅ تكوين multer للذاكرة المؤقتة
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  }
});

// ===================================================
// 🧠 AI FUNCTIONS
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
      logo TEXT,
      pdf_file TEXT,
      logo_cloudinary_url TEXT,
      pdf_cloudinary_url TEXT,
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
// ☁️ CLOUDINARY FILE MANAGEMENT
// ===================================================
async function uploadToCloudinary(fileBuffer, fileName, resourceType = 'image') {
  try {
    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          resource_type: resourceType,
          folder: '3win-projects',
          public_id: fileName,
          overwrite: true
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      
      uploadStream.end(fileBuffer);
    });
  } catch (error) {
    console.error('❌ Cloudinary upload error:', error);
    throw error;
  }
}

async function getCloudinaryUrl(publicId, resourceType = 'image') {
  try {
    return cloudinary.url(publicId, {
      resource_type: resourceType,
      secure: true
    });
  } catch (error) {
    console.error('❌ Cloudinary URL generation error:', error);
    throw error;
  }
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
// 🤖 AI SESSIONS MANAGEMENT
// ===================================================
let sessions = {};
const BMC_SECTIONS = [
  "Key Partners", "Key Activities", "Value Propositions",
  "Customer Relationships", "Customer Segments", "Key Resources",
  "Channels", "Cost Structure", "Revenue Streams",
];

// AI session functions remain the same as your existing code...
// [Include all your existing AI session functions here]
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
  
  const prompt = `أنت مستشار لمشاريع طلاب حاضنة أعمال 3win. قسم النموذج الحالي: "${arabicSection}". اكتب سؤالاً واحداً باللغة العربية لتوجيه الطالب في هذا القسم. يجب أن يكون السؤال واضحاً ومباشراً ويتعلق بـ ${arabicSection}.`;

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

// [Include other AI functions: produceFinalSummary, handleDesignAssistant, generateDesignSuggestions]

// ===================================================
// 🚀 BASIC ROUTES
// ===================================================
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
    ai: model ? "Available" : "Unavailable",
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
app.post("/api/projects", verifyToken, upload.fields([
  { name: "logo", maxCount: 1 }, 
  { name: "pdf_file", maxCount: 1 }
]), async (req, res) => {
  try {
    const { student_name, project_title, description, phone } = req.body;
    
    let logoUrl = null;
    let pdfUrl = null;

    // Upload logo to Cloudinary if exists
    if (req.files?.logo) {
      const logoResult = await uploadToCloudinary(
        req.files.logo[0].buffer,
        `logo_${Date.now()}`,
        'image'
      );
      logoUrl = logoResult.secure_url;
    }

    // Upload PDF to Cloudinary if exists
    if (req.files?.pdf_file) {
      const pdfResult = await uploadToCloudinary(
        req.files.pdf_file[0].buffer,
        `pdf_${Date.now()}`,
        'raw'
      );
      pdfUrl = pdfResult.secure_url;
    }

    const db = await openDb();
    const result = await db.run(
      `INSERT INTO projects (student_name, project_title, description, phone, logo, pdf_file, logo_cloudinary_url, pdf_cloudinary_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        student_name, 
        project_title, 
        description, 
        phone, 
        req.files?.logo ? `uploaded_logo_${Date.now()}` : null,
        req.files?.pdf_file ? `uploaded_pdf_${Date.now()}` : null,
        logoUrl,
        pdfUrl
      ]
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
});

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
    const result = await db.run("DELETE FROM projects WHERE id = ?", [req.params.id]);
    
    if (result.changes === 0) {
      return res.status(404).json({ message: "Project not found" });
    }
    
    res.json({ message: "✅ Project deleted successfully" });
  } catch (error) {
    console.error("Error deleting project:", error);
    res.status(500).json({ message: "Error deleting project" });
  }
});

// ===================================================
// 📁 FILE DOWNLOAD ROUTES WITH CLOUDINARY
// ===================================================
app.get("/api/projects/:id/download/:filetype", async (req, res) => {
  try {
    const { id, filetype } = req.params;
    const db = await openDb();
    const project = await db.get("SELECT * FROM projects WHERE id = ?", [id]);
    
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    let fileUrl;
    if (filetype === 'logo') {
      fileUrl = project.logo_cloudinary_url;
    } else if (filetype === 'pdf') {
      fileUrl = project.pdf_cloudinary_url;
    } else {
      return res.status(400).json({ error: 'Invalid file type' });
    }

    if (!fileUrl) {
      // Fallback to generating a file if Cloudinary URL doesn't exist
      return generateFallbackFile(req, res, filetype, project);
    }

    // Redirect to Cloudinary URL
    res.redirect(fileUrl);

  } catch (error) {
    console.error('File download error:', error);
    res.status(500).json({ error: 'Failed to download file' });
  }
});

// Fallback file generation
function generateFallbackFile(req, res, filetype, project) {
  if (filetype === 'pdf') {
    const doc = new PDFDocument();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${project.project_title}.pdf"`);
    
    doc.pipe(res);
    doc.fontSize(20).text(project.project_title, 100, 100);
    doc.fontSize(12).text(`الطالب: ${project.student_name}`, 100, 130);
    doc.text(`الوصف: ${project.description}`, 100, 160);
    doc.text(`الهاتف: ${project.phone}`, 100, 190);
    doc.text(`تاريخ الإنشاء: ${new Date(project.created_at).toLocaleDateString('ar-EG')}`, 100, 220);
    doc.text('تم إنشاء هذا الملف تلقائياً من خلال نظام 3win', 100, 250);
    doc.end();
  } else {
    // Generate SVG for logo
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Content-Disposition', `attachment; filename="${project.project_title}_logo.svg"`);
    
    const svgContent = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="400" height="300" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="gradient" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#3498db;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#2c3e50;stop-opacity:1" />
    </linearGradient>
  </defs>
  <rect width="400" height="300" fill="url(#gradient)"/>
  <text x="200" y="120" text-anchor="middle" fill="white" font-family="Arial" font-size="24" font-weight="bold">${project.project_title}</text>
  <text x="200" y="160" text-anchor="middle" fill="white" font-family="Arial" font-size="16">${project.student_name}</text>
  <text x="200" y="190" text-anchor="middle" fill="white" font-family="Arial" font-size="14">نظام 3win</text>
</svg>`;
    
    res.send(svgContent);
  }
}

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
// 🧠 AI ROUTES (Keep your existing AI routes)
// ===================================================
// [Include all your existing AI routes: /api/start, /api/next, /api/answer, /api/summary, /api/chat, etc.]

// ===================================================
// 🚀 START SERVER
// ===================================================
app.listen(PORT, '0.0.0.0', async () => {
  try {
    await createTables();
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📍 Health: http://localhost:${PORT}/api/health`);
    console.log(`☁️ Cloudinary: ${cloudinary.config().cloud_name ? 'Connected' : 'Not configured'}`);
    console.log(`🤖 AI: ${model ? 'Ready' : 'Disabled'}`);
  } catch (error) {
    console.error("❌ Failed to start server:", error);
  }
});
