const { createClient } = require('@libsql/client');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const db = createClient({
  url: 'libsql://callcenter-nikpereira.aws-ap-south-1.turso.io',
  authToken: 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3Nzk2NzAyNzMsImlkIjoiMDE5ZTVjOWMtYTIwMS03OTE4LWFjYmUtZjVmMWMwYzRlZGI2IiwicmlkIjoiOGI1YzU5NWItNTU4MS00MGY3LThjNzAtMWZhY2IxNjc5YjlmIn0.CKv8tUkY2UY2sshYW4c7Vn3FQWaCXiCgRgESquwVQQX63xw7wVVsKp0nWkncBZbdQXUjVUdIvERTovJjmcm4Cg',
});

async function run() {
  // Ensure table exists
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'agent',
      created_at TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1
    );
  `);

  const email = 'supervisor@cxeller8.com';
  const password = 'supervisor123';

  // Delete existing supervisor so we can re-create cleanly
  await db.execute({ sql: `DELETE FROM agents WHERE email=?`, args: [email] });

  const hash = await bcrypt.hash(password, 10);
  await db.execute({
    sql: `INSERT INTO agents (id, name, email, password_hash, role, created_at, is_active) VALUES (?,?,?,?,?,?,?)`,
    args: [uuidv4(), 'Supervisor', email, hash, 'supervisor', new Date().toISOString(), 1]
  });

  console.log('✅ Supervisor created successfully');
  console.log('   Email:    supervisor@cxeller8.com');
  console.log('   Password: supervisor123');

  // Verify it works
  const row = await db.execute({ sql: `SELECT * FROM agents WHERE email=?`, args: [email] });
  const agent = row.rows[0];
  const valid = await bcrypt.compare(password, agent.password_hash);
  console.log('   Login test:', valid ? '✅ PASS' : '❌ FAIL');
  process.exit(0);
}

run().catch(e => { console.error('Error:', e.message); process.exit(1); });
