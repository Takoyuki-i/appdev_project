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


app.set('view engine', 'ejs'); 
app.use(express.urlencoded({ extended: true })); 
app.use(express.static('public')); 
