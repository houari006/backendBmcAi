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
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const SECRET_KEY = process.env.SECRET_KEY || "mysecretkey";

// ===================================================
// 🧠 إعداد الذكاء الاصطناعي (Gemini)
// ===================================================
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "YOUR_GEMINI_API_KEY_HERE");
const model = genAI.getGenerativeModel({
  model: "gemini-2.0-flash",
  generationConfig: {
    maxOutputTokens: 1000,
    temperature: 0.7,
  },
});

async function generateContentWithRetry(prompt, maxRetries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await model.generateContent(prompt);
      const response = await result.response;
      return response.text();
    } catch (error) {
      lastError = error;
      console.error(`❌ AI attempt ${attempt} failed:`, error.message);
      if (error.status === 429) await new Promise(r => setTimeout(r, attempt * 2000));
      else break;
    }
  }
  throw lastError;
}

// ===================================================
// 🧱 قاعدة البيانات
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
// 🔐 Middleware التحقق من التوكن
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
// 🤖 المتغيرات والجلسات
// ===================================================
let sessions = {};
const BMC_SECTIONS = [
  "Key Partners", "Key Activities", "Value Propositions",
  "Customer Relationships", "Customer Segments", "Key Resources",
  "Channels", "Cost Structure", "Revenue Streams"
];

// ===================================================
// 🧩 Auth Routes
// ===================================================
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

// ===================================================
// 🧠 BMC و Design API Routes
// ===================================================
app.get("/", (req, res) => {
  res.send("✅ Backend is running successfully on Vercel!");
});

// مثال بسيط لتجربة الردود
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    message: "Server is running",
    timestamp: new Date().toISOString(),
  });
});

// ===================================================
// 🧩 PROJECT CRUD
// ===================================================
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname),
});
const upload = multer({ storage });

app.post(
  "/api/projects",
  verifyToken,
  upload.fields([{ name: "logo" }, { name: "pdf_file" }]),
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
    } catch (err) {
      console.error(err);
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
// 🚀 Export for Vercel
// ===================================================
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
