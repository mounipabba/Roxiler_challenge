const express = require('express');
const mysql = require('mysql2/promise');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// MySQL Connection
const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || 'localhost',
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || 'mysql123',
  database: process.env.MYSQL_DATABASE || 'mern_challenge',
  port: process.env.MYSQL_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Test connection and create table
(async () => {
  try {
    const conn = await pool.getConnection();
    console.log('Connected to MySQL');
    
    await conn.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id INT PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description TEXT NOT NULL,
        price DECIMAL(10,2) NOT NULL,
        category VARCHAR(100) NOT NULL,
        image VARCHAR(255) NOT NULL,
        sold BOOLEAN NOT NULL,
        date_of_sale DATETIME NOT NULL,
        INDEX idx_date_of_sale (date_of_sale)
      )
    `);
    console.log('Transactions table created or already exists');

    const [countResult] = await conn.query('SELECT COUNT(*) as count FROM transactions');
    const count = countResult[0].count;
    if (count === 0) {
      console.log('No data found, seeding database...');
      const response = await axios.get('https://s3.amazonaws.com/roxiler.com/product_transaction.json');
      const seedData = response.data;

      const insertQuery = `
        INSERT INTO transactions (id, title, description, price, category, image, sold, date_of_sale)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `;
      for (const item of seedData) {
        await conn.query(insertQuery, [
          item.id,
          item.title,
          item.description,
          item.price,
          item.category,
          item.image,
          item.sold,
          item.dateOfSale
        ]);
      }
      console.log(`Seeded ${seedData.length} documents into transactions table`);
    } else {
      console.log(`Database already contains ${count} records, skipping seed`);
    }

    conn.release();
  } catch (err) {
    console.error('MySQL connection or seeding error:', err);
  }
})();

const months = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

// Optional: Manual re-seeding endpoint
app.get('/api/init', async (req, res) => {
  try {
    console.log('Fetching data from third-party API...');
    const response = await axios.get('https://s3.amazonaws.com/roxiler.com/product_transaction.json');
    const seedData = response.data;

    console.log('Clearing existing data...');
    await pool.query('TRUNCATE TABLE transactions');

    console.log('Inserting seed data...');
    const insertQuery = `
      INSERT INTO transactions (id, title, description, price, category, image, sold, date_of_sale)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;
    for (const item of seedData) {
      await pool.query(insertQuery, [
        item.id,
        item.title,
        item.description,
        item.price,
        item.category,
        item.image,
        item.sold,
        item.dateOfSale
      ]);
    }

    console.log('Verifying insertion...');
    const [countResult] = await pool.query('SELECT COUNT(*) as count FROM transactions');
    const count = countResult[0].count;
    console.log(`Inserted ${count} documents into transactions table`);

    res.status(200).json({ message: 'Database initialized successfully', documentCount: count });
  } catch (error) {
    console.error('Error initializing database:', error.message);
    res.status(500).json({ error: 'Failed to initialize database', details: error.message });
  }
});

// List Transactions (Updated to return all data if perPage is not specified)
app.get('/api/transactions', async (req, res) => {
  const { month, search = '', page = 1, perPage } = req.query;

  if (!month || !months.includes(month)) {
    return res.status(400).send({ error: 'Invalid month' });
  }

  const monthNum = months.indexOf(month) + 1;

  try {
    let query = `
      SELECT * FROM transactions 
      WHERE MONTH(date_of_sale) = ?
    `;
    let countQuery = `
      SELECT COUNT(*) as total FROM transactions 
      WHERE MONTH(date_of_sale) = ?
    `;
    const params = [monthNum];
    const countParams = [monthNum];

    if (search.trim()) {
      query += ` AND (title LIKE ? OR description LIKE ? OR CAST(price AS CHAR) LIKE ?)`;
      countQuery += ` AND (title LIKE ? OR description LIKE ? OR CAST(price AS CHAR) LIKE ?)`;
      const searchParam = `%${search}%`;
      params.push(searchParam, searchParam, searchParam);
      countParams.push(searchParam, searchParam, searchParam);
    }

    // Apply pagination only if perPage is specified
    if (perPage) {
      const offset = (page - 1) * perPage;
      query += ` LIMIT ${perPage} OFFSET ${offset}`;
    }

    const [transactions] = await pool.query(query, params);
    const [totalResult] = await pool.query(countQuery, countParams);
    const total = totalResult[0].total;

    res.send({
      transactions,
      total,
      page: perPage ? Number(page) : 1,
      perPage: perPage ? Number(perPage) : total,
      totalPages: perPage ? Math.ceil(total / perPage) || 1 : 1
    });
  } catch (error) {
    console.error('Error fetching transactions:', error);
    res.status(500).send({ error: 'Error processing transactions' });
  }
});

// Statistics
app.get('/api/statistics', async (req, res) => {
  const { month } = req.query;

  if (!month || !months.includes(month)) {
    return res.status(400).send({ error: 'Invalid month' });
  }

  const monthNum = months.indexOf(month) + 1;

  try {
    const [totalSaleResult] = await pool.query(
      'SELECT SUM(price) as total FROM transactions WHERE MONTH(date_of_sale) = ? AND sold = TRUE',
      [monthNum]
    );
    const [soldItemsResult] = await pool.query(
      'SELECT COUNT(*) as count FROM transactions WHERE MONTH(date_of_sale) = ? AND sold = TRUE',
      [monthNum]
    );
    const [notSoldItemsResult] = await pool.query(
      'SELECT COUNT(*) as count FROM transactions WHERE MONTH(date_of_sale) = ? AND sold = FALSE',
      [monthNum]
    );

    res.send({
      totalSale: parseFloat(totalSaleResult[0].total) || 0,
      soldItems: parseInt(soldItemsResult[0].count) || 0,
      notSoldItems: parseInt(notSoldItemsResult[0].count) || 0
    });
  } catch (error) {
    console.error('Error calculating statistics:', error);
    res.status(500).send({ error: 'Error calculating statistics' });
  }
});

// Bar Chart
app.get('/api/barchart', async (req, res) => {
  const { month } = req.query;

  if (!month || !months.includes(month)) {
    return res.status(400).send({ error: 'Invalid month' });
  }

  const monthNum = months.indexOf(month) + 1;

  try {
    const query = `
      SELECT 
        CASE 
          WHEN price BETWEEN 0 AND 100 THEN '0-100'
          WHEN price BETWEEN 101 AND 200 THEN '101-200'
          WHEN price BETWEEN 201 AND 300 THEN '201-300'
          WHEN price BETWEEN 301 AND 400 THEN '301-400'
          WHEN price BETWEEN 401 AND 500 THEN '401-500'
          WHEN price BETWEEN 501 AND 600 THEN '501-600'
          WHEN price BETWEEN 601 AND 700 THEN '601-700'
          WHEN price BETWEEN 701 AND 800 THEN '701-800'
          WHEN price BETWEEN 801 AND 900 THEN '801-900'
          ELSE '901-above'
        END AS _id,
        COUNT(*) as count
      FROM transactions
      WHERE MONTH(date_of_sale) = ?
      GROUP BY 
        CASE 
          WHEN price BETWEEN 0 AND 100 THEN '0-100'
          WHEN price BETWEEN 101 AND 200 THEN '101-200'
          WHEN price BETWEEN 201 AND 300 THEN '201-300'
          WHEN price BETWEEN 301 AND 400 THEN '301-400'
          WHEN price BETWEEN 401 AND 500 THEN '401-500'
          WHEN price BETWEEN 501 AND 600 THEN '501-600'
          WHEN price BETWEEN 601 AND 700 THEN '601-700'
          WHEN price BETWEEN 701 AND 800 THEN '701-800'
          WHEN price BETWEEN 801 AND 900 THEN '801-900'
          ELSE '901-above'
        END
      ORDER BY _id
    `;
    const [result] = await pool.query(query, [monthNum]);
    res.send(result);
  } catch (error) {
    console.error('Error generating bar chart data:', error);
    res.status(500).send({ error: 'Error generating bar chart data' });
  }
});

// Pie Chart
app.get('/api/piechart', async (req, res) => {
  const { month } = req.query;

  if (!month || !months.includes(month)) {
    return res.status(400).send({ error: 'Invalid month' });
  }

  const monthNum = months.indexOf(month) + 1;

  try {
    const query = `
      SELECT category AS _id, COUNT(*) as count
      FROM transactions
      WHERE MONTH(date_of_sale) = ?
      GROUP BY category
    `;
    const [result] = await pool.query(query, [monthNum]);
    res.send(result);
  } catch (error) {
    console.error('Error generating pie chart data:', error);
    res.status(500).send({ error: 'Error generating pie chart data' });
  }
});

// Combined API
// Replace the /api/combined endpoint in server.js with this
app.get('/api/combined', async (req, res) => {
  const { month } = req.query;

  if (!month || !months.includes(month)) {
    return res.status(400).send({ error: 'Invalid month' });
  }

  try {
    const [statistics, barchart, piechart] = await Promise.all([
      axios.get(`https://roxiler-backend-kpxn.onrender.com/api/statistics?month=${month}`),
      axios.get(`https://roxiler-backend-kpxn.onrender.com/api/barchart?month=${month}`),
      axios.get(`https://roxiler-backend-kpxn.onrender.com/api/piechart?month=${month}`)
    ]);

    res.send({
      statistics: statistics.data,
      barchart: barchart.data,
      piechart: piechart.data
    });
  } catch (error) {
    console.error('Error fetching combined data:', error);
    res.status(500).send({ error: 'Error fetching combined data', details: error.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));