// ===================================================
// 🌐 IMPORTS & INITIAL SETUP
// ===================================================
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { GoogleGenerativeAI } from '@google/generative-ai';
import multer from 'multer';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const SECRET_KEY = process.env.SECRET_KEY || 'mysecretkey';

// CORS Configuration
app.use(cors({
  origin: ['http://localhost:4200', 'http://localhost:3000'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
}));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Multer Configuration
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024
  }
});

// Gemini AI Configuration
let genAI, model;
try {
  genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || 'AIzaSyB0yOVqdAXJ9H_sGMbXfIP12ozXtvYDfvY');
  model = genAI.getGenerativeModel({ 
    model: 'gemini-2.0-flash',
    generationConfig: {
      maxOutputTokens: 1000,
      temperature: 0.7,
    }
  });
  console.log('✅ Gemini AI configured successfully');
} catch (error) {
  console.warn('⚠️ Gemini AI configuration failed:', error.message);
}

// ===================================================
// 🗄️ DATABASE SETUP
// ===================================================
async function openDb() {
  const dbPath = process.env.NODE_ENV === 'production' 
    ? '/tmp/database.sqlite' 
    : './database.sqlite';
  
  return await open({
    filename: dbPath,
    driver: sqlite3.Database,
  });
}

async function createTables() {
  try {
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
    
    await db.close();
    console.log('✅ Database tables created successfully');
  } catch (error) {
    console.error('❌ Database table creation failed:', error);
  }
}

// ===================================================
// 🔐 AUTHENTICATION MIDDLEWARE
// ===================================================
function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(403).json({ message: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];
  jwt.verify(token, SECRET_KEY, (err, decoded) => {
    if (err) {
      return res.status(401).json({ message: 'Invalid token' });
    }
    req.user = decoded;
    next();
  });
}

// ===================================================
// 🚀 BASIC API ROUTES
// ===================================================

// Health Check
app.get('/', (req, res) => {
  res.json({ 
    message: '🚀 3win Business Incubator Backend is running!',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// Health Check API
app.get('/api/health', (req, res) => {
  res.json({
    status: '✅ Server is running',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    features: ['BMC Assistant', 'Design Assistant', 'Authentication']
  });
});

// ===================================================
// 👥 AUTHENTICATION ROUTES
// ===================================================
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    
    if (!name || !email || !password) {
      return res.status(400).json({ message: 'All fields are required' });
    }

    const db = await openDb();
    const hashedPassword = await bcrypt.hash(password, 10);
    
    await db.run(
      'INSERT INTO users (name, email, password) VALUES (?, ?, ?)',
      [name, email, hashedPassword]
    );
    
    res.status(201).json({ message: '✅ User registered successfully' });
  } catch (error) {
    if (error.message.includes('UNIQUE')) {
      return res.status(400).json({ message: 'Email already exists' });
    }
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    const db = await openDb();
    const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
    
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ message: 'Invalid password' });
    }

    const token = jwt.sign({ id: user.id, email: user.email }, SECRET_KEY, { 
      expiresIn: '2h' 
    });
    
    res.json({ 
      message: '✅ Login successful', 
      token,
      user: { id: user.id, name: user.name, email: user.email }
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ===================================================
// 📁 PROJECT ROUTES (NO AUTH FOR GET/DELETE)
// ===================================================

// Get all projects
app.get('/api/projects', async (req, res) => {
  try {
    const db = await openDb();
    const projects = await db.all('SELECT * FROM projects ORDER BY created_at DESC');
    res.json(projects);
  } catch (error) {
    console.error('Error fetching projects:', error);
    res.status(500).json({ message: 'Error fetching projects' });
  }
});

// Get single project
app.get('/api/projects/:id', async (req, res) => {
  try {
    const db = await openDb();
    const project = await db.get('SELECT * FROM projects WHERE id = ?', [req.params.id]);
    
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }
    
    res.json(project);
  } catch (error) {
    console.error('Error fetching project:', error);
    res.status(500).json({ message: 'Error fetching project' });
  }
});

// Create project (with auth)
app.post('/api/projects', verifyToken, upload.fields([
  { name: 'logo', maxCount: 1 }, 
  { name: 'pdf_file', maxCount: 1 }
]), async (req, res) => {
  try {
    const { student_name, project_title, description, phone } = req.body;
    
    const logo = req.files?.logo ? `uploaded_logo_${Date.now()}` : null;
    const pdf_file = req.files?.pdf_file ? `uploaded_pdf_${Date.now()}` : null;

    const db = await openDb();
    await db.run(
      `INSERT INTO projects (student_name, project_title, description, phone, logo, pdf_file)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [student_name, project_title, description, phone, logo, pdf_file]
    );
    
    res.status(201).json({ message: '✅ Project saved successfully' });
  } catch (error) {
    console.error('Error saving project:', error);
    res.status(500).json({ message: 'Error saving project' });
  }
});

// Delete project (NO AUTH)
app.delete('/api/projects/:id', async (req, res) => {
  try {
    const db = await openDb();
    const result = await db.run('DELETE FROM projects WHERE id = ?', [req.params.id]);
    
    if (result.changes === 0) {
      return res.status(404).json({ message: 'Project not found' });
    }
    
    res.json({ message: '✅ Project deleted successfully' });
  } catch (error) {
    console.error('Error deleting project:', error);
    res.status(500).json({ message: 'Error deleting project' });
  }
});

// ===================================================
// 🎨 DESIGNS ROUTES (NO AUTH)
// ===================================================

// Get all designs
app.get('/api/designs', async (req, res) => {
  try {
    const db = await openDb();
    const designs = await db.all('SELECT * FROM designs ORDER BY created_at DESC');
    res.json(designs);
  } catch (error) {
    console.error('Error fetching designs:', error);
    res.status(500).json({ message: 'Error fetching designs' });
  }
});

// Delete design (NO AUTH)
app.delete('/api/designs/:id', async (req, res) => {
  try {
    const db = await openDb();
    const result = await db.run('DELETE FROM designs WHERE id = ?', [req.params.id]);
    
    if (result.changes === 0) {
      return res.status(404).json({ message: 'Design not found' });
    }
    
    res.json({ message: '✅ Design deleted successfully' });
  } catch (error) {
    console.error('Error deleting design:', error);
    res.status(500).json({ message: 'Error deleting design' });
  }
});

// ===================================================
// 📁 FILE DOWNLOAD ROUTES
// ===================================================

// File download route
app.get('/api/files/:filename', (req, res) => {
  try {
    const { filename } = req.params;
    
    // Set CORS headers manually
    res.header('Access-Control-Allow-Origin', 'http://localhost:4200');
    res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    // Handle preflight requests
    if (req.method === 'OPTIONS') {
      return res.status(200).end();
    }

    console.log(`📥 File download request: ${filename}`);

    if (filename.includes('pdf')) {
      // Create a simple PDF file
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      
      // Simple PDF content
      const pdfContent = `%PDF-1.4
1 0 obj
<</Type/Catalog/Pages 2 0 R>>
endobj
2 0 obj
<</Type/Pages/Kids[3 0 R]/Count 1>>
endobj
3 0 obj
<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>
endobj
xref
0 4
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
trailer
<</Size 4/Root 1 0 R>>
startxref
0
%%EOF`;
      
      res.send(Buffer.from(pdfContent));
    } else {
      // Create a simple image file
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      
      // 1x1 pixel PNG
      const pngBuffer = Buffer.from([
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
        0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00,
        0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x00, 0x00, 0x01,
        0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00,
        0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82
      ]);
      
      res.send(pngBuffer);
    }
  } catch (error) {
    console.error('File download error:', error);
    res.status(500).json({ error: 'Failed to download file' });
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
      console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
