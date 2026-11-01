const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

// ใช้แบบนี้เพื่อให้โปรแกรมวิ่งไปหาไฟล์ .db ที่วางอยู่ข้างๆ ไฟล์ .exe ในโฟลเดอร์ dist
const isDev = !app.isPackaged;
const dbPath = isDev 
    ? path.join(__dirname, 'stockmb.db') 
    : path.join(path.dirname(app.getPath('exe')), 'stockmb.db');
const db = new sqlite3.Database(dbPath);


db.serialize(() => {
    // 1. ตั้งค่าระบบพื้นฐาน
    db.run("PRAGMA foreign_keys = ON");
    db.run("PRAGMA journal_mode = WAL");

    // 2. สร้างตาราง Employee (ต้องมีก่อนใช้ Login)
    db.run(`CREATE TABLE IF NOT EXISTS employee (
        emp_id TEXT PRIMARY KEY, 
        emp_name TEXT, 
        age INTEGER, 
        sex TEXT, 
        phone TEXT, 
        position TEXT, 
        salary REAL, 
        qualification TEXT, 
        year_qual INTEGER, 
        email TEXT, 
        username TEXT, 
        password TEXT, 
        role TEXT DEFAULT 'Staff'
    )`);

    // 3. สร้างตาราง Product
    db.run(`CREATE TABLE IF NOT EXISTS product (
        product_id TEXT PRIMARY KEY, 
        product_name TEXT, 
        pro_category TEXT, 
        price REAL, 
        quantity INTEGER, 
        image TEXT
    )`);

    // 4. สร้างตารางประกอบอื่นๆ
    db.run(`CREATE TABLE IF NOT EXISTS import_expenses (
        import_id INTEGER PRIMARY KEY AUTOINCREMENT, 
        product_id TEXT NOT NULL, 
        import_qty INTEGER NOT NULL, 
        unit_cost REAL NOT NULL, 
        total_cost REAL NOT NULL, 
        recorded_by TEXT,
        import_date DATETIME DEFAULT CURRENT_TIMESTAMP, 
        FOREIGN KEY (product_id) REFERENCES product(product_id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS sales_history (
        sale_id INTEGER PRIMARY KEY AUTOINCREMENT, 
        product_id TEXT, 
        total_amount REAL, 
        sold_by TEXT,
        sale_date DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 5. จัดการ Index และ Migration (เพิ่มคอลัมน์ถ้ายังไม่มี)
    db.run("CREATE INDEX IF NOT EXISTS idx_pro_cat ON product(pro_category)");
    db.run("ALTER TABLE sales_history ADD COLUMN sold_by TEXT", (err) => {
        if (!err) console.log(" Check: คอลัมน์ sold_by พร้อมใช้งาน");
    });

    console.log(" ฐานข้อมูลและตารางทั้งหมดตรวจสอบเรียบร้อยแล้ว");
});


function createWindow() {
    const win = new BrowserWindow({
        width: 1280,
        height: 800,
        webPreferences: {
            nodeIntegration: true,     
            contextIsolation: false    
        }
    });
    
    // โหลดหน้าแรก (ตรวจสอบโฟลเดอร์ src ให้ถูกต้อง)
    win.loadFile(path.join(__dirname, 'src/Login.html'));

    win.webContents.on('did-fail-load', () => {
        console.error(" ERROR: ไม่สามารถโหลดไฟล์ Login.html ได้");
    });
}
// ตัวแปรเสริมสำหรับช่วยจัดการ Query ตามช่วงเวลา
function getTimeFilterSQL(filterType) {
    switch(filterType) {
        case 'monthly':
            return "strftime('%Y-%m', sale_date) = strftime('%Y-%m', 'now')";
        case 'yearly':
            return "strftime('%Y', sale_date) = strftime('%Y', 'now')";
        case 'daily':
        default:
            return "sale_date >= date('now', '-7 days')";
    }
}

// ในไฟล์ main.js
ipcMain.on('login-attempt', (event, data) => {
    const { username, password } = data;
    
    
    const loginSql = "SELECT emp_name, password, role FROM employee WHERE username = ?";
    
    db.get(loginSql, [username], (err, row) => {
        if (err) {
            event.reply('login-response', { success: false, message: "ระบบฐานข้อมูลขัดข้อง" });
            return;
        }

        if (!row) {
            event.reply('login-response', { success: false, message: "ไม่พบชื่อผู้ใช้งานนี้ในระบบ" });
            return;
        }

        if (row.password === password) {
            event.reply('login-response', { 
                success: true, 
                userName: row.emp_name,
                role: row.role 
            });
        } else {
            event.reply('login-response', { success: false, message: "รหัสผ่านไม่ถูกต้อง" });
        }
    });
});





// ================= ระบบ Dashboard & Graphs (Real-time) =================

//  กราฟหน้านำเข้า: เปรียบเทียบ รายจ่ายพนักงาน (ฟ้า) vs นำเข้าสินค้า (เขียว)
ipcMain.on('get-import-summary-chart', (event) => {
    const sql = `
        SELECT 'รายจ่ายพนักงาน' as category, COALESCE(SUM(salary), 0) as total_amount FROM employee
        UNION ALL
        SELECT 'นำเข้าสินค้า' as category, COALESCE(SUM(total_cost), 0) as total_amount FROM import_expenses
    `;
    db.all(sql, [], (err, rows) => {
        if (!err) event.reply('render-import-summary-chart', rows);
    });
});

// 🟢 ตัวเลขสรุปรายรับจากการขายและต้นทุนสินค้า (สำหรับกล่องเขียว/แดง ในหน้า index.html)
ipcMain.on('get-sales-only-stats', (event) => {
    const sql = `
        SELECT 
            (SELECT SUM(total_amount) FROM sales_history) as revenue,
            (SELECT SUM(total_cost) FROM import_expenses) as importCost
    `;
    db.get(sql, [], (err, row) => {
        if (!err) event.reply('render-sales-only-stats', { 
            revenue: row.revenue || 0, 
            importCost: row.importCost || 0 
        });
    });
});

// สรุปยอดเงินรวม Dashboard
ipcMain.on('get-dashboard-stats', (event) => {
    const sql = `
        SELECT 
            (SELECT SUM(total_amount) FROM sales_history) as total_sales,
            (SELECT SUM(total_cost) FROM import_expenses) as total_expenses,
            (SELECT SUM(salary) FROM employee) as total_salaries
    `;
    db.get(sql, [], (err, row) => {
        if (!err) {
            const sales = row.total_sales || 0;
            const importCosts = row.total_expenses || 0;
            const salaries = row.total_salaries || 0;
            const profit = sales - (importCosts + salaries);

           event.reply('render-dashboard-stats', {
                sales: sales,
                importCosts: importCosts,
                salaries: salaries,
                profit: profit
            });
        }
    }); 
});
ipcMain.on('get-revenue-cost-chart', (event) => {
    const sql = `
        SELECT 'รายรับจากการขาย' as label, COALESCE(SUM(total_amount), 0) as amount, '#28a745' as color 
        FROM sales_history
        UNION ALL
        SELECT 'ต้นทุนสินค้าทั้งหมด' as label, COALESCE(SUM(total_cost), 0) as amount, '#dc3545' as color 
        FROM import_expenses
    `;
    db.all(sql, [], (err, rows) => {
        if (!err) event.reply('render-revenue-cost-chart', rows);
    });
});


// ================= ระบบพนักงาน (Employee) =================

ipcMain.on('load-employees', (event) => {
    db.all("SELECT * FROM employee", [], (err, rows) => {
        if (!err) event.reply('render-employees', rows);
    });
});

ipcMain.on('add-employee', (event, employeeData) => {
    const { emp_id, emp_name, age, sex, phone, position, salary, qualification, year_qual, email, username, password, role } = employeeData;
    const sql = `INSERT INTO employee (emp_id, emp_name, age, sex, phone, position, salary, qualification, year_qual, email, username, password, role) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    db.run(sql, [emp_id, emp_name, age, sex, phone, position, salary, qualification, year_qual, email, username, password, role], function(err) {
        if (!err) event.reply('add-employee-response', { success: true, data: employeeData });
    });
});

ipcMain.on('get-employee-by-id', (event, id) => {
    db.get("SELECT * FROM employee WHERE emp_id = ?", [id], (err, row) => {
        if (!err) event.reply('employee-data-response', row);
    });
});

ipcMain.on('update-employee', (event, data) => {
    const { emp_id, emp_name, age, sex, phone, position, salary, qualification, email, username, password, role, old_id } = data;
    const sql = `UPDATE employee SET emp_id = ?, emp_name = ?, age = ?, sex = ?, phone = ?, position = ?, salary = ?, qualification = ?, email = ?, username = ?, password = ?, role = ? WHERE emp_id = ?`;
    db.run(sql, [emp_id, emp_name, age, sex, phone, position, salary, qualification, email, username, password, role, old_id], function(err) {
        if (!err) event.reply('update-response', { success: true });
    });
});

ipcMain.on('delete-employee', (event, empId) => {
    db.run("DELETE FROM employee WHERE emp_id = ?", [empId], function(err) {
        if (!err) event.reply('delete-employee-response', { success: true });
    });
});

// ================= ระบบสินค้าและสต็อก (Product Management) =================

ipcMain.on('load-products', (event) => {
    db.all("SELECT * FROM product", [], (err, rows) => {
        if (!err) event.reply('render-products', rows);
    });
});

ipcMain.on('get-categories', (event) => {
    db.all("SELECT DISTINCT pro_category FROM product WHERE pro_category IS NOT NULL AND pro_category != ''", [], (err, rows) => {
        if (!err) event.reply('render-categories', rows);
    });
});

ipcMain.on('get-product-by-id', (event, id) => {
    db.get("SELECT * FROM product WHERE product_id = ?", [id], (err, row) => {
        if (!err) event.reply('product-data-response', row);
    });
});

ipcMain.on('add-product', (event, data) => {
    const sql = `INSERT INTO product (product_id, product_name, pro_category, price, quantity, image) VALUES (?, ?, ?, ?, ?, ?)`;
    db.run(sql, [data.product_id, data.product_name, data.pro_category, data.price, data.quantity, data.image], (err) => {
        if (!err) db.all("SELECT * FROM product", [], (err, rows) => event.reply('render-products', rows));
    });
});

ipcMain.on('update-product', (event, data) => {
    const sql = `UPDATE product SET product_id = ?, product_name = ?, pro_category = ?, quantity = ?, price = ?, image = ? WHERE product_id = ?`;
    db.run(sql, [data.product_id, data.product_name, data.pro_category, data.quantity, data.price, data.image, data.old_id], function(err) {
        if (!err) db.all("SELECT * FROM product", [], (err, rows) => event.reply('render-products', rows));
    });
});

ipcMain.on('delete-product', (event, productId) => {
    db.run("DELETE FROM product WHERE product_id = ?", [productId], function(err) {
        if (!err) {
            db.all("SELECT * FROM product", [], (err, rows) => {
                event.reply('render-products', rows);
                event.reply('delete-product-response', { success: true });
            });
        }
    });
});

// ในไฟล์ main.js
ipcMain.on('update-stock-quantity', (event, data) => {
    // รับค่า recordedBy เพิ่มมาจาก frontend
    const { product_id, add_quantity, buy_cost, recordedBy } = data;
    const total_cost = add_quantity * buy_cost;

    db.serialize(() => {
        // อัปเดตจำนวนในสต็อก
        db.run("UPDATE product SET quantity = quantity + ? WHERE product_id = ?", [add_quantity, product_id]);
        
        // 🟢 บันทึกลงตารางรายจ่าย พร้อมชื่อพนักงาน ( recordedBy )
        // หมายเหตุ: หากตารางยังไม่มีคอลัมน์นี้ ให้ใช้ ALTER TABLE เพิ่มคอลัมน์ก่อนครับ
        const sql = `INSERT INTO import_expenses (product_id, import_qty, unit_cost, total_cost, recorded_by) VALUES (?, ?, ?, ?, ?)`;
        
       db.run(sql, [product_id, add_quantity, buy_cost, total_cost, recordedBy], (err) => {
    if (!err) {
        db.all("SELECT * FROM product", [], (err, rows) => {
            event.reply('render-products', rows);
            event.reply('update-stock-success');
        });
            }
        });
        });
     });   
// ================= ระบบขายและตัดสต็อก (Checkout) =================
//  ตัวเลขสรุปรายรับจากการขาย, ต้นทุนสินค้า และรายจ่ายรวมทั้งหมด


// 🟢 แก้ไข IPC ใน main.js เพื่อรองรับการค้นหาและกรองข้อมูล
ipcMain.on('get-import-history', (event, filters = {}) => {
    const { searchTerm = '', category = '' } = filters;
    
    let sql = `
    SELECT 
        strftime('%d/%m/%Y', i.import_date) as display_date,
        p.product_name, p.product_id, p.image, p.pro_category,
        i.import_qty, i.import_date, i.recorded_by  -- ✅ เพิ่ม i.recorded_by ตรงนี้
    FROM import_expenses i
    LEFT JOIN product p ON i.product_id = p.product_id
    WHERE 1=1
`;

    const params = [];
    
    // กรองด้วยชื่อสินค้าหรือรหัสสินค้า
    if (searchTerm) {
        sql += ` AND (p.product_name LIKE ? OR p.product_id LIKE ?)`;
        params.push(`%${searchTerm}%`, `%${searchTerm}%`);
    }

    // กรองด้วยหมวดหมู่สินค้า
    if (category && category !== 'สินค้าทั้งหมด') {
        sql += ` AND p.pro_category = ?`;
        params.push(category);
    }

    sql += ` ORDER BY i.import_date DESC`;

    db.all(sql, params, (err, rows) => {
        if (!err) {
            const grouped = rows.reduce((acc, row) => {
                if (!acc[row.display_date]) acc[row.display_date] = { date: row.display_date, items: [] };
                acc[row.display_date].items.push(row);
                return acc;
            }, {});
            event.reply('render-import-history', grouped);
        }
    });
});


// ดึงสถิติรวมทั้งหมดของสินค้าหนึ่งชิ้น (อ้างอิงทุกรายการที่มี)
ipcMain.on('get-individual-product-stats', (event, productId) => {
    const sql = `
        SELECT 
            p.product_id, 
            p.product_name, 
            p.price, 
            p.quantity, 
            p.image,
            -- รวมยอดรายได้ทั้งหมดจากตารางประวัติการขาย
            (SELECT COALESCE(SUM(total_amount), 0) FROM sales_history WHERE product_id = p.product_id) as total_sales_revenue,
            -- รวมจำนวนชิ้นที่ขายออกทั้งหมด
            (SELECT COALESCE(SUM(quantity), 0) FROM sales_history WHERE product_id = p.product_id) as total_sales_qty,
            -- รวมต้นทุนการนำเข้าทั้งหมดจากตารางรายจ่ายนำเข้า
            (SELECT COALESCE(SUM(total_cost), 0) FROM import_expenses WHERE product_id = p.product_id) as total_import_cost,
            -- รวมจำนวนชิ้นที่นำเข้าทั้งหมด
            (SELECT COALESCE(SUM(import_qty), 0) FROM import_expenses WHERE product_id = p.product_id) as total_import_qty
        FROM product p
        WHERE p.product_id = ?
    `;

    db.get(sql, [productId], (err, row) => {
        if (err) {
            console.error("SQL Error:", err.message);
            return;
        }
        if (row) {
            event.reply('render-individual-product-stats', row);
        }
    });
});

//  ดึงข้อมูลสำหรับพล็อตกราฟ (ย้อนหลัง 7 วัน)
ipcMain.on('get-product-graph-data', (event, productId) => {
    const sql = `
        SELECT date_label, SUM(import_total) as imports, SUM(sales_total) as sales
        FROM (
            SELECT date(import_date) as date_label, SUM(import_qty) as import_total, 0 as sales_total
            FROM import_expenses WHERE product_id = ? AND import_date >= date('now', '-7 days') GROUP BY date_label
            UNION ALL
            SELECT date(sale_date) as date_label, 0 as import_total, SUM(total_amount / (SELECT price FROM product WHERE product_id = ?)) as sales_total
            FROM sales_history WHERE product_id = ? AND sale_date >= date('now', '-7 days') GROUP BY date_label
        ) GROUP BY date_label ORDER BY date_label ASC
    `;

    db.all(sql, [productId, productId, productId], (err, rows) => {
        if (!err) {
            
            event.reply('render-product-graph', {
                productId: productId,
                graphData: rows
            });
        }
    });
});

// ดึงรายการสินค้าทั้งหมดเพื่อนำไปแสดงในส่วนเลื่อนดู (Product List)
// แก้ไขใน main.js
ipcMain.on('get-all-product-list', (event) => {
    const sql = "SELECT product_id, product_name, price, image, pro_category FROM product";
    db.all(sql, [], (err, rows) => {
        if (!err) event.reply('render-product-list', rows);
    });
});

// 🟢 ส่วนเริ่มแอป: เพิ่มคอลัมน์เก็บชื่อผู้ขายในตารางยอดขาย
db.serialize(() => {
    db.run("ALTER TABLE sales_history ADD COLUMN sold_by TEXT", (err) => {
        if (!err) console.log("✅ เพิ่มคอลัมน์ sold_by สำเร็จ");
    });
});

ipcMain.on('get-sales-history', (event, filters = {}) => {
    const { searchTerm = '', category = '' } = filters; 
    
    let sql = `
        SELECT strftime('%d/%m/%Y', s.sale_date) as display_date,
               COALESCE(p.product_name, 'ไม่พบชื่อสินค้า') as product_name, 
               COALESCE(p.product_id, s.product_id) as product_id, 
               p.image, COALESCE(p.pro_category, 'ทั่วไป') as pro_category,
               CASE WHEN p.price > 0 THEN (s.total_amount / p.price) ELSE 0 END as sale_qty,
               COALESCE(s.sold_by, 'ไม่ระบุชื่อ') as sold_by
        FROM sales_history s
        LEFT JOIN product p ON TRIM(s.product_id) = TRIM(p.product_id) 
        WHERE 1=1
    `;

    const params = [];
    if (searchTerm) {
        sql += ` AND (p.product_name LIKE ? OR s.product_id LIKE ?)`;
        params.push(`%${searchTerm}%`, `%${searchTerm}%`);
    }

    if (category && category !== 'สินค้าทั้งหมด') {
        sql += ` AND p.pro_category = ?`;
        params.push(category);
    }

    sql += ` ORDER BY s.sale_date DESC LIMIT 100`; 

    db.all(sql, params, (err, rows) => {
        if (!err) {
            const grouped = rows.reduce((acc, row) => {
                if (!acc[row.display_date]) acc[row.display_date] = { date: row.display_date, items: [] };
                acc[row.display_date].items.push(row);
                return acc;
            }, {});
            event.reply('render-sales-history', grouped);
        }
    });
}); 
ipcMain.on('reset-password-attempt', (event, data) => {
    const { email, newPassword } = data;
    
    // 1. ล้างช่องว่างที่อาจติดมาจากการกรอก (Whitespace)
    const cleanEmail = email.trim(); 

    // 2. ตรวจสอบอีเมลในฐานข้อมูลแบบ Case-insensitive (ไม่สนตัวพิมพ์เล็ก/ใหญ่)
    const checkEmail = "SELECT * FROM employee WHERE LOWER(email) = LOWER(?)";
    
    db.get(checkEmail, [cleanEmail], (err, row) => {
        if (err) {
            event.reply('reset-password-response', { success: false, message: "ฐานข้อมูลขัดข้อง" });
            return;
        }
        
        if (!row) {
            // หากไม่พบอีเมลในระบบ
            event.reply('reset-password-response', { success: false, message: "ไม่พบอีเมลนี้ในระบบ" });
            return;
        }

        // 3. หากพบอีเมล ให้ทำการ UPDATE รหัสผ่านใหม่ลงในตาราง employee
        const updateSql = "UPDATE employee SET password = ? WHERE LOWER(email) = LOWER(?)";
        
        db.run(updateSql, [newPassword, cleanEmail], function(err) {
            if (err) {
                event.reply('reset-password-response', { success: false, message: "เปลี่ยนรหัสผ่านไม่สำเร็จ" });
            } else {
                // แจ้งเตือนเมื่อเปลี่ยนรหัสผ่านสำเร็จ
                event.reply('reset-password-response', { success: true, message: "เปลี่ยนรหัสผ่านสำเร็จ!" });
            }
        });
    });
});


ipcMain.on('import-products-bulk', (event, productList) => {
    db.serialize(() => {
        // ใช้ BEGIN TRANSACTION เพื่อให้ทำงานเร็วขึ้นและปลอดภัย
        db.run("BEGIN TRANSACTION");
        
        const stmt = db.prepare("INSERT OR REPLACE INTO product (product_id, product_name, pro_category, price, quantity, image) VALUES (?, ?, ?, ?, ?, ?)");
        
        let successCount = 0;
        productList.forEach(item => {
            // ตรวจสอบชื่อ Key ให้ตรงกับหัวตาราง Excel เป๊ะๆ (พิมพ์เล็กทั้งหมด)
            if (item.product_id && item.product_name) {
                stmt.run(
                    String(item.product_id).trim(), 
                    String(item.product_name).trim(), 
                    item.pro_category || 'ทั่วไป', 
                    Number(item.price) || 0, 
                    Number(item.quantity) || 0, 
                    item.image || ''
                );
                successCount++;
            }
        });

        stmt.finalize();
        db.run("COMMIT", (err) => {
            if (err) {
                console.error("❌ Transaction Error:", err.message);
                db.run("ROLLBACK");
            } else {
                event.reply('import-success', successCount);
            }
        });
    });
});

ipcMain.on('process-checkout', (event, data) => {
    const { cart, soldBy } = data; // รับตะกร้าสินค้าและชื่อพนักงาน
    
    db.serialize(() => {
        db.run("BEGIN TRANSACTION");

        const updateStock = db.prepare("UPDATE product SET quantity = quantity - ? WHERE product_id = ?");
        const insertHistory = db.prepare("INSERT INTO sales_history (product_id, total_amount, sold_by) VALUES (?, ?, ?)");

        cart.forEach(item => {
            // 1. หักจำนวนในตาราง product
            updateStock.run(item.qty, item.product_id);
            // 2. บันทึกประวัติการขาย (ราคาต่อชิ้น * จำนวน)
            insertHistory.run(item.product_id, (item.price * item.qty), soldBy);
        });

        updateStock.finalize();
        insertHistory.finalize();

        db.run("COMMIT", (err) => {
            if (err) {
                db.run("ROLLBACK");
                event.reply('checkout-response', { success: false });
            } else {
                event.reply('checkout-success'); 
            }
        });
    });
});

// 
ipcMain.on('load-data-request', (event) => {
    // 1. ดึงข้อมูลพนักงาน
    db.all("SELECT * FROM employee", [], (err, empRows) => {
        if (!err) event.reply('render-employees', empRows);
    });

    // 2. ดึงข้อมูลสินค้า
    db.all("SELECT * FROM product", [], (err, proRows) => {
        if (!err) event.reply('render-products', proRows);
    });
});
app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });