const express = require('express'); 
const mysql = require('mysql2'); 
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

app.get('/', (req, res) => {
    res.render('index');
});

app.listen(3001, () => {
    console.log('Server is running at http://localhost:3001');
});


app.get('/api/events', (req, res) => {
    res.json([]);
});

app.get('/login', (req, res) => {
    res.render('login');
});

app.set('view engine', 'ejs'); 
app.use(express.urlencoded({ extended: true })); 
app.use(express.static('public')); 