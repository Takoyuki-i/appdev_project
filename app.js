
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
app.use(express.json());
app.use(express.static('public'));

app.use(session({
    secret: process.env.SESSION_SECRET || 'change-this-development-session-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: false,
        maxAge: 1000 * 60 * 60 * 2
    }
}));

app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
});

// Homepage
app.get('/', (req, res) => {
    res.render('index', { user: req.session.user || null });
});

// Public calendar: only approved events are published.
app.get('/api/events', (req, res) => {
    const sql = `
        SELECT
            eventId,
            eventName,
            description,
            DATE_FORMAT(eventDate, '%Y-%m-%d') AS startDate,
            DATE_FORMAT(
                DATE_ADD(eventDate, INTERVAL duration - 1 DAY),
                '%Y-%m-%d'
            ) AS lastDate,
            TIME_FORMAT(startTime, '%H:%i:%s') AS startTime,
            TIME_FORMAT(endTime, '%H:%i:%s') AS endTime,
            duration,
            venueName
        FROM events
        INNER JOIN venues ON events.venueId = venues.venueId
        WHERE approvalStatus = 'approved'
        ORDER BY eventDate, startTime
    `;

    db.query(sql, (err, rows) => {
        if (err) {
            console.error('Public events query error:', err);
            return res.status(500).json({ error: 'Unable to load events.' });
        }

        const calendarEvents = rows.map((event) => ({
            id: event.eventId,
            title: event.eventName,
            start: `${event.startDate}T${event.startTime}`,
            end: `${event.lastDate}T${event.endTime}`,
            extendedProps: {
                description: event.description,
                venue: event.venueName,
                duration: event.duration
            }
        }));

        return res.json(calendarEvents);
    });
});

// Ordinary user dashboard. Show only approved future/current events the user heads or co-heads.
app.get('/dashboard', (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    const sql = `
        SELECT
            events.eventId,
            events.eventName,
            events.description,
            DATE_FORMAT(events.eventDate, '%Y-%m-%d') AS eventDate,
            DATE_FORMAT(
                DATE_ADD(events.eventDate, INTERVAL events.duration - 1 DAY),
                '%Y-%m-%d'
            ) AS lastDate,
            TIME_FORMAT(events.startTime, '%h:%i %p') AS startTime,
            TIME_FORMAT(events.endTime, '%h:%i %p') AS endTime,
            events.duration,
            events.approvalStatus,
            venues.venueName
        FROM events
        INNER JOIN venues ON events.venueId = venues.venueId
        WHERE events.approvalStatus = 'approved'
          AND (events.headId = ? OR events.coHeadId = ?)
          AND DATE_ADD(events.eventDate, INTERVAL events.duration - 1 DAY) >= CURDATE()
        ORDER BY events.eventDate, events.startTime
    `;

    db.query(sql, [req.session.user.accountId, req.session.user.accountId], (err, upcomingEvents) => {
        if (err) {
            console.error('Dashboard events query error:', err);
            return res.status(500).send('Unable to load your dashboard right now.');
        }

        return res.render('dashboard', {
            user: req.session.user,
            upcomingEvents
        });
    });
});

// Event proposal form: co-head choices come from existing accounts, and venues from venues table.
app.get('/events/new', (req, res) => {
    if (!req.session.user) return res.redirect('/login');

    const venuesSql = `
        SELECT venueId, venueName
        FROM venues
        WHERE LOWER(venueStatus) = 'available'
        ORDER BY venueName
    `;
    const accountsSql = `
        SELECT accountId, firstName, lastName, email
        FROM accounts
        WHERE accountId <> ?
        ORDER BY firstName, lastName
    `;
    const departmentsSql = `
        SELECT departmentId, departmentName, departmentCode
        FROM departments
        ORDER BY departmentName
    `;

    db.query(venuesSql, (venueErr, venues) => {
        if (venueErr) {
            console.error('Available venues query error:', venueErr);
            return res.status(500).send('Unable to load venues right now.');
        }

        db.query(accountsSql, [req.session.user.accountId], (accountErr, accounts) => {
            if (accountErr) {
                console.error('Co-head accounts query error:', accountErr);
                return res.status(500).send('Unable to load account choices right now.');
            }

            db.query(departmentsSql, (departmentErr, departments) => {
                if (departmentErr) {
                    console.error('Departments query error:', departmentErr);
                    return res.status(500).send('Unable to load departments right now.');
                }

                return res.render('event_form', {
                    user: req.session.user,
                    venues,
                    accounts,
                    departments,
                    error: null,
                    formData: {}
                });
            });
        });
    });
});

// Submit a proposal. The head is always the logged-in account, never a form-supplied ID.
app.post('/events/new', (req, res) => {
    if (!req.session.user) return res.redirect('/login');

    const eventName = String(req.body.eventName || '').trim();
    const description = String(req.body.description || '').trim();
    const eventDate = String(req.body.eventDate || '').trim();
    const startTime = String(req.body.startTime || '').trim();
    const endTime = String(req.body.endTime || '').trim();
    const duration = Number.parseInt(req.body.duration, 10);
    const venueId = Number.parseInt(req.body.venueId, 10);
    const eventScope = String(req.body.eventScope || 'Campus-wide').trim();
    const departmentInput = String(req.body.departmentId || '').trim();
    const departmentId = departmentInput ? Number.parseInt(departmentInput, 10) : null;
    const coHeadInput = String(req.body.coHeadId || '').trim();
    const coHeadId = coHeadInput ? Number.parseInt(coHeadInput, 10) : null;
    const formData = { eventName, description, eventDate, startTime, endTime, duration, venueId, eventScope, departmentId: departmentInput, coHeadId: coHeadInput };

    const renderError = (message, statusCode = 400) => {
        const venuesSql = `SELECT venueId, venueName FROM venues WHERE LOWER(venueStatus) = 'available' ORDER BY venueName`;
        const accountsSql = `SELECT accountId, firstName, lastName, email FROM accounts WHERE accountId <> ? ORDER BY firstName, lastName`;
        const departmentsSql = `SELECT departmentId, departmentName, departmentCode FROM departments ORDER BY departmentName`;
        db.query(venuesSql, (venueErr, venues) => {
            if (venueErr) return res.status(500).send('Unable to reload venues.');
            db.query(accountsSql, [req.session.user.accountId], (accountErr, accounts) => {
                if (accountErr) return res.status(500).send('Unable to reload account choices.');
                db.query(departmentsSql, (departmentErr, departments) => {
                    if (departmentErr) return res.status(500).send('Unable to reload departments.');
                    return res.status(statusCode).render('event_form', {
                        user: req.session.user, venues, accounts, departments, error: message, formData
                    });
                });
            });
        });
    };

    const parsedDate = new Date(`${eventDate}T00:00:00Z`);
    const validDate = /^\d{4}-\d{2}-\d{2}$/.test(eventDate) && !Number.isNaN(parsedDate.getTime()) && parsedDate.toISOString().slice(0, 10) === eventDate;

    if (!eventName || !description || !validDate || !startTime || !endTime || !Number.isInteger(venueId) || venueId < 1 || !Number.isInteger(duration) || duration < 1 || duration > 365) {
        return renderError('Please complete all required fields. Duration must be between 1 and 365 days.');
    }

    if (!['Campus-wide', 'Department-specific'].includes(eventScope)) {
        return renderError('Please select a valid event scope.');
    }

    if (eventScope === 'Campus-wide' && departmentInput) {
        // Ignore any department submitted for a campus-wide event.
    } else if (eventScope === 'Campus-wide') {
        // Campus-wide events do not belong to a specific department.
    } else if (!Number.isInteger(departmentId) || departmentId < 1) {
        return renderError('Please choose a department for a department-specific event.');
    }

    if (startTime >= endTime) {
        return renderError('The end time must be later than the start time for each event day.');
    }

    const validCoHead = (callback) => {
        if (coHeadId === null) return callback(null, null);
        if (!Number.isInteger(coHeadId) || coHeadId === req.session.user.accountId) {
            return callback(new Error('Please choose a valid co-head other than yourself.'));
        }
        db.query('SELECT accountId FROM accounts WHERE accountId = ? LIMIT 1', [coHeadId], (err, rows) => {
            if (err) return callback(err);
            if (!rows.length) return callback(new Error('The selected co-head account does not exist.'));
            return callback(null, coHeadId);
        });
    };

    validCoHead((coHeadErr, confirmedCoHeadId) => {
        if (coHeadErr) return renderError(coHeadErr.message);

        db.query(
            `SELECT venueId FROM venues WHERE venueId = ? AND LOWER(venueStatus) = 'available' LIMIT 1`,
            [venueId],
            (venueErr, availableVenues) => {
                if (venueErr) {
                    console.error('Venue validation query error:', venueErr);
                    return res.status(500).send('Unable to verify the selected venue right now.');
                }
                if (!availableVenues.length) {
                    return renderError('Please choose a venue that is currently available.');
                }

        const confirmDepartment = (callback) => {
            if (eventScope === 'Campus-wide') return callback(null, null);
            db.query(
                'SELECT departmentId FROM departments WHERE departmentId = ? LIMIT 1',
                [departmentId],
                (departmentErr, rows) => {
                    if (departmentErr) return callback(departmentErr);
                    if (!rows.length) return callback(new Error('The selected department does not exist.'));
                    return callback(null, departmentId);
                }
            );
        };

        confirmDepartment((departmentErr, confirmedDepartmentId) => {
            if (departmentErr) {
                if (departmentErr.message === 'The selected department does not exist.') {
                    return renderError(departmentErr.message);
                }
                console.error('Department validation query error:', departmentErr);
                return res.status(500).send('Unable to verify the selected department right now.');
            }

        // Venue is reserved for every calendar day covered by the proposal.
        const conflictSql = `
            SELECT eventId
            FROM events
            WHERE venueId = ?
              AND approvalStatus IN ('pending', 'approved')
              AND eventDate < DATE_ADD(?, INTERVAL ? DAY)
              AND DATE_ADD(eventDate, INTERVAL duration DAY) > ?
            LIMIT 1
        `;

        db.query(conflictSql, [venueId, eventDate, duration, eventDate], (conflictErr, conflicts) => {
            if (conflictErr) {
                console.error('Venue conflict query error:', conflictErr);
                return res.status(500).send('Unable to check venue availability right now.');
            }
            if (conflicts.length) {
                return renderError('This venue is already reserved for at least one day in the selected duration. Please choose another venue or date.');
            }

            const insertSql = `
                INSERT INTO events
                    (eventName, description, headId, coHeadId, eventDate, startTime, endTime, venueId, eventScope, departmentId, duration, approvalStatus)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
            `;
            const values = [
                eventName, description, req.session.user.accountId, confirmedCoHeadId,
                eventDate, startTime, endTime, venueId, eventScope, confirmedDepartmentId, duration
            ];

            db.query(insertSql, values, (insertErr) => {
                if (insertErr) {
                    console.error('Event proposal insert error:', insertErr);
                    return res.status(500).send('Unable to submit the event proposal right now. Check that your events table matches the provided structure.');
                }
                return res.redirect('/dashboard');
            });
        });
        });
            }
        );
    });
});

// Admin API: retrieve proposals for the review dashboard.
app.get('/api/admin/event-proposals', (req, res) => {
    if (!req.session.admin) {
        return res.status(401).json({ error: 'Admin login required.' });
    }

    const allowedStatuses = ['pending', 'approved', 'rejected', 'cancelled', 'all'];
    const requestedStatus = String(req.query.status || 'pending').toLowerCase();
    const status = allowedStatuses.includes(requestedStatus) ? requestedStatus : 'pending';

    const sql = `
        SELECT
            events.eventId AS id,
            events.eventName AS title,
            events.description,
            CONCAT(head.firstName, ' ', head.lastName) AS organizerName,
            events.eventScope AS category,
            venues.venueName AS venue,
            DATE_FORMAT(events.eventDate, '%Y-%m-%d') AS eventDate,
            TIME_FORMAT(events.startTime, '%H:%i:%s') AS startTime,
            TIME_FORMAT(events.endTime, '%H:%i:%s') AS endTime,
            events.duration,
            events.approvalStatus AS status,
            DATE_FORMAT(events.createdAt, '%Y-%m-%d %H:%i:%s') AS submittedAt,
            NULL AS reviewNote
        FROM events
        INNER JOIN accounts AS head ON events.headId = head.accountId
        INNER JOIN venues ON events.venueId = venues.venueId
        WHERE (? = 'all' OR events.approvalStatus = ?)
        ORDER BY FIELD(events.approvalStatus, 'pending', 'approved', 'rejected', 'cancelled'), events.createdAt DESC
    `;

    db.query(sql, [status, status], (err, events) => {
        if (err) {
            console.error('Admin event proposals query error:', err);
            return res.status(500).json({ error: 'Unable to load event proposals.' });
        }
        return res.json({ events });
    });
});

// Admin API: approve or reject a submitted event proposal.

app.post('/api/admin/event-proposals/:id/decision', (req, res) => {
    if (!req.session.admin) {
        return res.status(401).json({
            error: 'Admin login required.'
        });
    }

    const eventId = Number.parseInt(req.params.id, 10);
    const status = String(req.body.status || '').toLowerCase();
    const reviewNote = String(req.body.reviewNote || '').trim();

    if (
        !Number.isInteger(eventId) ||
        eventId < 1 ||
        !['approved', 'rejected', 'cancelled'].includes(status)
    ) {
        return res.status(400).json({
            error: 'Invalid event ID or decision.'
        });
    }

    // Approve/reject pending proposals.
    // Cancel only events that have already been approved.
    const expectedStatus = status === 'cancelled'
        ? 'approved'
        : 'pending';

    const updateSql = `
        UPDATE events
        SET approvalStatus = ?
        WHERE eventId = ?
          AND approvalStatus = ?
    `;

    db.query(
        updateSql,
        [status, eventId, expectedStatus],
        (err, result) => {
            if (err) {
                console.error('Admin event decision update error:', err);

                return res.status(500).json({
                    error: 'Unable to update this event. Check the approvalStatus column in your database.'
                });
            }

            if (result.affectedRows === 0) {
                return res.status(404).json({
                    error: status === 'cancelled'
                        ? 'Approved event not found. It may already have been cancelled or changed.'
                        : 'Pending proposal not found. It may already have been reviewed.'
                });
            }

            const fetchSql = `
                SELECT
                    events.eventId AS id,
                    events.eventName AS title,
                    events.description,
                    CONCAT(head.firstName, ' ', head.lastName) AS organizerName,
                    events.eventScope AS category,
                    venues.venueName AS venue,
                    DATE_FORMAT(events.eventDate, '%Y-%m-%d') AS eventDate,
                    TIME_FORMAT(events.startTime, '%H:%i:%s') AS startTime,
                    TIME_FORMAT(events.endTime, '%H:%i:%s') AS endTime,
                    events.duration,
                    events.approvalStatus AS status,
                    DATE_FORMAT(events.createdAt, '%Y-%m-%d %H:%i:%s') AS submittedAt,
                    NULL AS reviewNote
                FROM events
                INNER JOIN accounts AS head
                    ON events.headId = head.accountId
                INNER JOIN venues
                    ON events.venueId = venues.venueId
                WHERE events.eventId = ?
            `;

            db.query(fetchSql, [eventId], (fetchErr, rows) => {
                if (fetchErr) {
                    console.error('Admin event decision fetch error:', fetchErr);

                    return res.status(500).json({
                        error: 'The status was saved, but the updated event could not be loaded.'
                    });
                }

                return res.json({
                    success: true,
                    event: rows[0],
                    reviewNote
                });
            });
        }
    );
});


// Admin dashboard - admins only
app.get('/admin', (req, res) => {
    if (!req.session.admin) {
        return res.redirect('/login');
    }

    res.render('admin');
});

// Login page
app.get('/login', (req, res) => {
    if (req.session.admin) {
        return res.redirect('/admin');
    }

    if (req.session.user) {
        return res.redirect('/');
    }

    res.render('login', { error: null });
});

// Shared login for admins and ordinary users
app.post('/login', (req, res) => {
    const identifier = String(req.body.email || '').trim();
    const password = String(req.body.password || '');

    if (!identifier || !password) {
        return res.status(400).render('login', {
            error: 'Please enter your email or admin number and password.'
        });
    }

    // Check admin account first
    const adminSql = `
        SELECT adminID, adminnumber, adminpasswordHash
        FROM admin
        WHERE adminnumber = ?
        LIMIT 1
    `;

    db.query(adminSql, [identifier], async (err, adminResults) => {
        if (err) {
            console.error('Admin login database error:', err);
            return res.status(500).render('login', {
                error: 'Something went wrong. Please try again.'
            });
        }

        try {
            if (adminResults.length > 0) {
                const admin = adminResults[0];

                const passwordMatches = await bcrypt.compare(
                    password,
                    admin.adminpasswordHash
                );

                if (!passwordMatches) {
                    return res.status(401).render('login', {
                        error: 'Invalid email/admin number or password.'
                    });
                }

                return req.session.regenerate((sessionErr) => {
                    if (sessionErr) {
                        console.error('Admin session error:', sessionErr);
                        return res.status(500).render('login', {
                            error: 'Unable to log in right now. Please try again.'
                        });
                    }

                    req.session.admin = {
                        adminID: admin.adminID,
                        adminnumber: admin.adminnumber
                    };

                    req.session.save((saveErr) => {
                        if (saveErr) {
                            console.error('Admin session save error:', saveErr);
                            return res.status(500).render('login', {
                                error: 'Unable to log in right now. Please try again.'
                            });
                        }

                        return res.redirect('/admin');
                    });
                });
            }

            // No matching admin number; check ordinary user
            const email = identifier.toLowerCase();

            const userSql = `
                SELECT accountId, firstName, lastName, email, passwordHash
                FROM accounts
                WHERE email = ?
                LIMIT 1
            `;

            db.query(userSql, [email], async (userErr, userResults) => {
                if (userErr) {
                    console.error('User login database error:', userErr);
                    return res.status(500).render('login', {
                        error: 'Something went wrong. Please try again.'
                    });
                }

                if (userResults.length === 0) {
                    return res.status(401).render('login', {
                        error: 'Invalid email/admin number or password.'
                    });
                }

                try {
                    const account = userResults[0];

                    const passwordMatches = await bcrypt.compare(
                        password,
                        account.passwordHash
                    );

                    if (!passwordMatches) {
                        return res.status(401).render('login', {
                            error: 'Invalid email/admin number or password.'
                        });
                    }

                    req.session.regenerate((sessionErr) => {
                        if (sessionErr) {
                            console.error('User session error:', sessionErr);
                            return res.status(500).render('login', {
                                error: 'Unable to log in right now. Please try again.'
                            });
                        }

                        req.session.user = {
                            accountId: account.accountId,
                            firstName: account.firstName,
                            lastName: account.lastName,
                            email: account.email
                        };

                        req.session.save((saveErr) => {
                            if (saveErr) {
                                console.error('User session save error:', saveErr);
                                return res.status(500).render('login', {
                                    error: 'Unable to log in right now. Please try again.'
                                });
                            }

                            return res.redirect('/');
                        });
                    });
                } catch (compareErr) {
                    console.error('User password verification error:', compareErr);
                    return res.status(500).render('login', {
                        error: 'Something went wrong. Please try again.'
                    });
                }
            });
        } catch (compareErr) {
            console.error('Admin password verification error:', compareErr);
            return res.status(500).render('login', {
                error: 'Something went wrong. Please try again.'
            });
        }
    });
});

// Registration page
app.get('/register', (req, res) => {
    if (req.session.user || req.session.admin) {
        return res.redirect('/');
    }

    res.render('register', { error: null });
});

// Register ordinary users
app.post('/register', async (req, res) => {
    const firstName = String(req.body.firstName || '').trim();
    const lastName = String(req.body.lastName || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const confirmPassword = String(req.body.confirmPassword || '');

    if (!firstName || !lastName || !email || !password || !confirmPassword) {
        return res.status(400).render('register', {
            error: 'Please complete all fields.'
        });
    }

    if (password.length < 8) {
        return res.status(400).render('register', {
            error: 'Password must be at least 8 characters long.'
        });
    }

    if (password !== confirmPassword) {
        return res.status(400).render('register', {
            error: 'The passwords do not match.'
        });
    }

    try {
        const passwordHash = await bcrypt.hash(password, 10);

        const sql = `
            INSERT INTO accounts (firstName, lastName, passwordHash, email)
            VALUES (?, ?, ?, ?)
        `;

        db.query(sql, [firstName, lastName, passwordHash, email], (err) => {
            if (err) {
                if (err.code === 'ER_DUP_ENTRY') {
                    return res.status(409).render('register', {
                        error: 'That email is already registered. Please log in instead.'
                    });
                }

                console.error('Registration database error:', err);
                return res.status(500).render('register', {
                    error: 'Unable to create your account right now. Please try again.'
                });
            }

            return res.redirect('/login');
        });
    } catch (hashErr) {
        console.error('Password hashing error:', hashErr);
        return res.status(500).render('register', {
            error: 'Unable to create your account right now. Please try again.'
        });
    }
});

// Logout
app.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error('Logout error:', err);
            return res.status(500).send('Unable to log out right now.');
        }

        res.clearCookie('connect.sid', { path: '/' });
        return res.redirect('/');
    });
});

app.post('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error('Logout error:', err);
            return res.status(500).send('Unable to log out right now.');
        }

        res.clearCookie('connect.sid', { path: '/' });
        return res.redirect('/');
    });
});

// Start server
app.listen(3001, () => {
    console.log('Server is running at http://localhost:3001');
});
