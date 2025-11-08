import sqlite3 from "sqlite3";
import { open } from "sqlite";

// 🔌 فتح الاتصال بقاعدة البيانات
export async function openDb() {
  return open({
    filename: "./startups.db",
    driver: sqlite3.Database
  });
}

// 🧱 إنشاء جدول المشاريع
export async function createProjectsTable() {
  const db = await openDb();
  await db.exec(`
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
  console.log("✅ Table 'projects' ready!");
}

// 🔐 إنشاء جدول المستخدمين (للمصادقة)
export async function createUserTable() {
  const db = await openDb();
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log("✅ Table 'users' ready!");
}

// 💡 جدول لجلسات BMC لكل طالب/مشروع
export async function createBMCSessionsTable() {
  const db = await openDb();
  await db.exec(`
    CREATE TABLE IF NOT EXISTS bmc_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_name TEXT NOT NULL,
      project_title TEXT,
      current_section TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log("✅ Table 'bmc_sessions' ready!");
}

// 💬 جدول لحفظ إجابات BMC
export async function createBMCAnswersTable() {
  const db = await openDb();
  await db.exec(`
    CREATE TABLE IF NOT EXISTS bmc_answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      section TEXT NOT NULL,
      question TEXT NOT NULL,
      answer TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(session_id) REFERENCES bmc_sessions(id)
    )
  `);
  console.log("✅ Table 'bmc_answers' ready!");
}

// 🚀 تهيئة جميع الجداول مرة واحدة عند تشغيل السيرفر
export async function initializeDatabase() {
  await createProjectsTable();
  await createUserTable();
  await createBMCSessionsTable();
  await createBMCAnswersTable();
  console.log("🚀 All tables initialized successfully!");
}
