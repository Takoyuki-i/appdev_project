const express = require('express');
const mysql = require('mysql2');
const session = require('express-session');
const bcrypt = require('bcryptjs');

const app = express();

const db = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'event_managementDB'
});

db.connect((err) => {
    if (err) {
        console.error('Database connection failed:', err);
        return;
    }
    console.log('Connected to MySQL');
});

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// For local development. Set SESSION_SECRET in your environment before deployment.
app.use(session({
    secret: process.env.SESSION_SECRET || 'change-this-development-session-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: false, // Set true when deployed over HTTPS.
        maxAge: 1000 * 60 * 60 * 2
    }
}));

app.get('/', (req, res) => {
    res.render('index', { user: req.session.user || null });
});

app.get('/api/events', (req, res) => {
    // Existing placeholder; event loading can be connected later.
    res.json([]);
});

// Simple dashboard placeholder. Only logged-in users can view it.
app.get('/dashboard', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    res.render('dashboard', { user: req.session.user });
});

app.get('/login', (req, res) => {
    if (req.session.user) return res.redirect('/');
    res.render('login', { error: null });
});

app.post('/login', (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!email || !password) {
        return res.status(400).render('login', { error: 'Please enter your email and password.' });
    }

    const sql = 'SELECT accountId, firstName, lastName, email, passwordHash FROM accounts WHERE email = ? LIMIT 1';
    db.query(sql, [email], async (err, results) => {
        if (err) {
            console.error('Login database error:', err);
            return res.status(500).render('login', { error: 'Something went wrong. Please try again.' });
        }

        if (results.length === 0) {
            return res.status(401).render('login', { error: 'Invalid email or password.' });
        }

        try {
            const account = results[0];
            const passwordMatches = await bcrypt.compare(password, account.passwordHash);
            if (!passwordMatches) {
                return res.status(401).render('login', { error: 'Invalid email or password.' });
            }

            // Regenerate the session after authentication to reduce session-fixation risk.
            req.session.regenerate((sessionErr) => {
                if (sessionErr) {
                    console.error('Session error:', sessionErr);
                    return res.status(500).render('login', { error: 'Unable to log in right now. Please try again.' });
                }

                req.session.user = {
                    accountId: account.accountId,
                    firstName: account.firstName,
                    lastName: account.lastName,
                    email: account.email
                };

                req.session.save((saveErr) => {
                    if (saveErr) {
                        console.error('Session save error:', saveErr);
                        return res.status(500).render('login', { error: 'Unable to log in right now. Please try again.' });
                    }
                    return res.redirect('/');
                });
            });
        } catch (compareErr) {
            console.error('Password verification error:', compareErr);
            return res.status(500).render('login', { error: 'Something went wrong. Please try again.' });
        }
    });
});

app.get('/register', (req, res) => {
    if (req.session.user) return res.redirect('/');
    res.render('register', { error: null });
});

app.post('/register', async (req, res) => {
    const firstName = String(req.body.firstName || '').trim();
    const lastName = String(req.body.lastName || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const confirmPassword = String(req.body.confirmPassword || '');

    if (!firstName || !lastName || !email || !password || !confirmPassword) {
        return res.status(400).render('register', { error: 'Please complete all fields.' });
    }
    if (password.length < 8) {
        return res.status(400).render('register', { error: 'Password must be at least 8 characters long.' });
    }
    if (password !== confirmPassword) {
        return res.status(400).render('register', { error: 'The passwords do not match.' });
    }

    try {
        const passwordHash = await bcrypt.hash(password, 10);
        const sql = 'INSERT INTO accounts (firstName, lastName, passwordHash, email) VALUES (?, ?, ?, ?)';
        db.query(sql, [firstName, lastName, passwordHash, email], (err) => {
            if (err) {
                if (err.code === 'ER_DUP_ENTRY') {
                    return res.status(409).render('register', { error: 'That email is already registered. Please log in instead.' });
                }
                console.error('Registration database error:', err);
                return res.status(500).render('register', { error: 'Unable to create your account right now. Please try again.' });
            }
            // Account is usable immediately; send the user to log in.
            return res.redirect('/login');
        });
    } catch (hashErr) {
        console.error('Password hashing error:', hashErr);
        return res.status(500).render('register', { error: 'Unable to create your account right now. Please try again.' });
    }
});

app.post('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error('Logout session error:', err);
            return res.status(500).send('Unable to log out right now. Please try again.');
        }
        res.clearCookie('connect.sid');
        return res.redirect('/');
    });
});

app.listen(3001, () => {
    console.log('Server is running at http://localhost:3001');
});
