 const express = require("express");
const session = require("express-session");
const bcrypt = require("bcrypt");
const path = require("path");

require("dotenv").config({
    path: path.join(__dirname, "../.env")
});

const db = require("./db");

const app = express();

app.use(express.json());

app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: false,
        maxAge: 1000 * 60 * 60 * 8
    }
}));

app.use(express.static(path.join(__dirname, "../frontend")));

// Authentication middleware
function isLoggedIn(req, res, next) {
    if (!req.session.user) {
        return res.status(401).json({
            message: "Please login first"
        });
    }

    next();
}

function isManager(req, res, next) {
    if (!req.session.user ||
        req.session.user.role !== "manager") {
        return res.status(403).json({
            message: "Manager access required"
        });
    }

    next();
}

// Home
app.get("/", (req, res) => {
    res.sendFile(
        path.join(__dirname, "../frontend/index.html")
    );
});

// Register employee
app.post("/api/register", async (req, res) => {
    const { name, email, password, department } = req.body;

    if (!name || !email || !password || !department) {
        return res.status(400).json({
            message: "All fields are required"
        });
    }

    if (password.length < 6) {
        return res.status(400).json({
            message: "Password must contain at least 6 characters"
        });
    }

    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        const [existing] = await connection.execute(
            "SELECT employee_id FROM employees WHERE email = ?",
            [email]
        );

        if (existing.length > 0) {
            await connection.rollback();

            return res.status(409).json({
                message: "Email already registered"
            });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const [result] = await connection.execute(
            `INSERT INTO employees
            (name, email, password, department, role)
            VALUES (?, ?, ?, ?, 'employee')`,
            [name, email, hashedPassword, department]
        );

        const [types] = await connection.execute(
            "SELECT leave_type_id, total_days FROM leave_types"
        );

        for (const type of types) {
            await connection.execute(
                `INSERT INTO leave_balances
                (employee_id, leave_type_id, available_days)
                VALUES (?, ?, ?)`,
                [result.insertId, type.leave_type_id, type.total_days]
            );
        }

        await connection.commit();

        res.status(201).json({
            message: "Registration successful! Please login."
        });

    } catch (error) {
        await connection.rollback();
        console.error(error);

        res.status(500).json({
            message: "Registration failed"
        });

    } finally {
        connection.release();
    }
});

// Login
app.post("/api/login", async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({
            message: "Email and password required"
        });
    }

    try {
        const [rows] = await db.execute(
            "SELECT * FROM employees WHERE email = ?",
            [email]
        );

        if (rows.length === 0) {
            return res.status(401).json({
                message: "Invalid email or password"
            });
        }

        const user = rows[0];

        const valid = await bcrypt.compare(
            password,
            user.password
        );

        if (!valid) {
            return res.status(401).json({
                message: "Invalid email or password"
            });
        }

        req.session.regenerate((err) => {
            if (err) {
                return res.status(500).json({
                    message: "Session error"
                });
            }

            req.session.user = {
                employee_id: user.employee_id,
                name: user.name,
                email: user.email,
                role: user.role
            };

            res.json({
                message: "Login successful",
                role: user.role
            });
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            message: "Login failed"
        });
    }
});

// Current user
app.get("/api/me", isLoggedIn, (req, res) => {
    res.json(req.session.user);
});

// Logout
app.post("/api/logout", isLoggedIn, (req, res) => {
    req.session.destroy(() => {
        res.clearCookie("connect.sid");
        res.json({ message: "Logged out successfully" });
    });
});

// Leave types
app.get("/api/leave-types", isLoggedIn, async (req, res) => {
    try {
        const [rows] = await db.execute(
            "SELECT * FROM leave_types ORDER BY leave_type_id"
        );

        res.json(rows);

    } catch (error) {
        res.status(500).json({
            message: "Unable to fetch leave types"
        });
    }
});

// Employee leave balances
app.get("/api/balances", isLoggedIn, async (req, res) => {
    try {
        const [rows] = await db.execute(
            `SELECT lt.leave_name, lb.available_days
             FROM leave_balances lb
             JOIN leave_types lt
             ON lb.leave_type_id = lt.leave_type_id
             WHERE lb.employee_id = ?`,
            [req.session.user.employee_id]
        );

        res.json(rows);

    } catch (error) {
        res.status(500).json({
            message: "Unable to fetch balances"
        });
    }
});

// Apply for leave
app.post("/api/leave-requests", isLoggedIn, async (req, res) => {
    const { leave_type_id, start_date, end_date, reason } = req.body;

    if (!leave_type_id || !start_date || !end_date || !reason?.trim()) {
        return res.status(400).json({
            message: "Please fill all leave details"
        });
    }

    const start = new Date(start_date + "T00:00:00Z");
    const end = new Date(end_date + "T00:00:00Z");

    if (Number.isNaN(start.getTime()) ||
        Number.isNaN(end.getTime()) || end < start) {
        return res.status(400).json({
            message: "Invalid leave dates"
        });
    }

    // Leave days are calculated as calendar days, inclusive.
    const days = Math.floor((end - start) / 86400000) + 1;

    try {
        const [balance] = await db.execute(
            `SELECT available_days FROM leave_balances
             WHERE employee_id = ? AND leave_type_id = ?`,
            [req.session.user.employee_id, leave_type_id]
        );

        if (balance.length === 0 || balance[0].available_days < days) {
            return res.status(400).json({
                message: "Insufficient leave balance"
            });
        }

        await db.execute(
            `INSERT INTO leave_requests
            (employee_id, leave_type_id, start_date, end_date, reason)
            VALUES (?, ?, ?, ?, ?)`,
            [
                req.session.user.employee_id,
                leave_type_id,
                start_date,
                end_date,
                reason.trim()
            ]
        );

        res.status(201).json({
            message: "Leave request submitted successfully"
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            message: "Unable to submit leave request"
        });
    }
});

// Employee request history
app.get("/api/my-requests", isLoggedIn, async (req, res) => {
    try {
        const [rows] = await db.execute(
            `SELECT lr.*, lt.leave_name
             FROM leave_requests lr
             JOIN leave_types lt
             ON lr.leave_type_id = lt.leave_type_id
             WHERE lr.employee_id = ?
             ORDER BY lr.applied_on DESC`,
            [req.session.user.employee_id]
        );

        res.json(rows);

    } catch (error) {
        res.status(500).json({
            message: "Unable to fetch history"
        });
    }
});

// Manager: view all requests
app.get("/api/manager/requests", isManager, async (req, res) => {
    try {
        const [rows] = await db.execute(
            `SELECT lr.*, e.name AS employee_name,
             e.department, lt.leave_name
             FROM leave_requests lr
             JOIN employees e ON lr.employee_id = e.employee_id
             JOIN leave_types lt ON lr.leave_type_id = lt.leave_type_id
             ORDER BY lr.applied_on DESC`
        );

        res.json(rows);

    } catch (error) {
        res.status(500).json({
            message: "Unable to fetch requests"
        });
    }
});

// Manager: approve or reject
app.patch("/api/manager/requests/:id", isManager, async (req, res) => {
    const requestId = req.params.id;
    const { status, comments } = req.body;

    if (!["Approved", "Rejected"].includes(status)) {
        return res.status(400).json({
            message: "Invalid status"
        });
    }

    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        const [requests] = await connection.execute(
            `SELECT * FROM leave_requests
             WHERE request_id = ? FOR UPDATE`,
            [requestId]
        );

        if (requests.length === 0) {
            await connection.rollback();

            return res.status(404).json({
                message: "Request not found"
            });
        }

        const request = requests[0];

        if (request.status !== "Pending") {
            await connection.rollback();

            return res.status(400).json({
                message: "This request has already been processed"
            });
        }

        if (status === "Approved") {
            const start = new Date(request.start_date);
            const end = new Date(request.end_date);
            const days = Math.round((end - start) / 86400000) + 1;

            const [updateBalance] = await connection.execute(
                `UPDATE leave_balances
                 SET available_days = available_days - ?
                 WHERE employee_id = ?
                 AND leave_type_id = ?
                 AND available_days >= ?`,
                [
                    days,
                    request.employee_id,
                    request.leave_type_id,
                    days
                ]
            );

            if (updateBalance.affectedRows === 0) {
                await connection.rollback();

                return res.status(400).json({
                    message: "Insufficient leave balance to approve"
                });
            }
        }

        await connection.execute(
            `UPDATE leave_requests SET status = ?
             WHERE request_id = ?`,
            [status, requestId]
        );

        await connection.execute(
            `INSERT INTO leave_history
             (request_id, manager_id, status, comments)
             VALUES (?, ?, ?, ?)`,
            [
                requestId,
                req.session.user.employee_id,
                status,
                comments || ""
            ]
        );

        await connection.commit();

        res.json({
            message: `Leave ${status.toLowerCase()} successfully`
        });

    } catch (error) {
        await connection.rollback();
        console.error(error);

        res.status(500).json({
            message: "Unable to process request"
        });

    } finally {
        connection.release();
    }
});

// Manager approval history
app.get("/api/manager/history", isManager, async (req, res) => {
    try {
        const [rows] = await db.execute(
            `SELECT lh.*, lr.employee_id, e.name AS employee_name
             FROM leave_history lh
             JOIN leave_requests lr ON lh.request_id = lr.request_id
             JOIN employees e ON lr.employee_id = e.employee_id
             ORDER BY lh.action_date DESC`
        );

        res.json(rows);

    } catch (error) {
        res.status(500).json({
            message: "Unable to fetch approval history"
        });
    }
});

// Manager dashboard statistics
app.get("/api/manager/stats", isManager, async (req, res) => {
    try {
        const [[employeeCount]] = await db.execute(
            "SELECT COUNT(*) AS totalEmployees FROM employees WHERE role = 'employee'"
        );

        const [[pendingCount]] = await db.execute(
            "SELECT COUNT(*) AS pendingRequests FROM leave_requests WHERE status = 'Pending'"
        );

        const [[approvedCount]] = await db.execute(
            "SELECT COUNT(*) AS approvedLeaves FROM leave_requests WHERE status = 'Approved'"
        );

        const [[rejectedCount]] = await db.execute(
            "SELECT COUNT(*) AS rejectedLeaves FROM leave_requests WHERE status = 'Rejected'"
        );

        res.json({
            totalEmployees: employeeCount.totalEmployees,
            pendingRequests: pendingCount.pendingRequests,
            approvedLeaves: approvedCount.approvedLeaves,
            rejectedLeaves: rejectedCount.rejectedLeaves
        });

    } catch (error) {
        console.error("Manager stats error:", error);

        res.status(500).json({
            message: "Unable to fetch manager dashboard statistics"
        });
    }
});

// Manager: view all employees
app.get("/api/manager/employees", isManager, async (req, res) => {
    try {
        const [rows] = await db.execute(
            `SELECT employee_id, name, email, department
             FROM employees
             WHERE role = 'employee'
             ORDER BY name ASC`
        );

        res.json(rows);

    } catch (error) {
        console.error("Manager employees error:", error);

        res.status(500).json({
            message: "Unable to fetch employees"
        });
    }
});

// Start server
const PORT = process.env.PORT || 5000;

app.listen(PORT, async () => {
    try {
        await db.query("SELECT 1");

        console.log("MySQL Connected Successfully!");
        console.log(`Server running at http://localhost:${PORT}`);

    } catch (error) {
        console.error("MySQL connection failed:", error.message);
    }
});