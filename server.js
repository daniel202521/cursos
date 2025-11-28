const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
// IMPORTANTE PARA RENDER: Usar process.env.PORT
const PORT = process.env.PORT || 5000;

// Middlewares
app.use(cors()); // Permite conexiones externas (Vital para que funcione desde tu PC local hacia Render)
app.use(bodyParser.json({ limit: '10mb' })); // Límite alto para firmas

// --- CONEXIÓN A MONGODB ---
const MONGO_URI = "mongodb+srv://daniel:daniel25@capacitacion.nxd7yl9.mongodb.net/tool_inventory?retryWrites=true&w=majority&appName=capacitacion&authSource=admin";

mongoose.connect(MONGO_URI)
.then(() => console.log('✅ Conectado a MongoDB Atlas'))
.catch(err => console.error('❌ Error de conexión:', err));

// --- MODELOS ---
const ItemSchema = new mongoose.Schema({
    name: String,
    sku: String,
    type: String,
    stock: Number,
    total: Number
});
const Item = mongoose.model('Item', ItemSchema);

const LoanSchema = new mongoose.Schema({
    responsible: String,
    location: String,
    date: String,
    items: Array,
    signature: String,
    status: { type: String, default: 'Active' },
    returnDate: String
});
const Loan = mongoose.model('Loan', LoanSchema);

// --- RUTAS DE LA API ---

// GET: Inventario
app.get('/api/inventory', async (req, res) => {
    try {
        const items = await Item.find();
        res.json(items);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST: Crear item
app.post('/api/inventory', async (req, res) => {
    try {
        const newItem = new Item(req.body);
        await newItem.save();
        res.json(newItem);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET: Préstamos
app.get('/api/loans', async (req, res) => {
    try {
        const loans = await Loan.find().sort({ _id: -1 });
        res.json(loans);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST: Crear ticket (Transacción)
app.post('/api/loans', async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const loan = new Loan(req.body);
        await loan.save({ session });

        for (const cartItem of req.body.items) {
            await Item.findByIdAndUpdate(
                cartItem._id, 
                { $inc: { stock: -cartItem.qty } },
                { session }
            );
        }

        await session.commitTransaction();
        res.json({ message: 'Ticket creado', loan });
    } catch (err) {
        await session.abortTransaction();
        res.status(500).json({ error: err.message });
    } finally {
        session.endSession();
    }
});

// PUT: Devolver
app.put('/api/loans/:id/return', async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const loan = await Loan.findById(req.params.id);
        if (!loan) throw new Error('Ticket no encontrado');
        if (loan.status === 'Returned') throw new Error('Ya devuelto');

        loan.status = 'Returned';
        loan.returnDate = new Date().toLocaleString();
        await loan.save({ session });

        for (const cartItem of loan.items) {
            await Item.findByIdAndUpdate(
                cartItem._id, 
                { $inc: { stock: cartItem.qty } },
                { session }
            );
        }

        await session.commitTransaction();
        res.json({ message: 'Devolución procesada', loan });
    } catch (err) {
        await session.abortTransaction();
        res.status(500).json({ error: err.message });
    } finally {
        session.endSession();
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en el puerto ${PORT}`);
});
