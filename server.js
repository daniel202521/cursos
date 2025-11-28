const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const PORT = 5000;

// Middlewares
app.use(cors()); // Permite que el HTML se conecte al servidor
app.use(bodyParser.json({ limit: '10mb' })); // Limite alto para las firmas en base64

// --- CONEXIÓN A MONGODB ---
// Nota: He añadido 'tool_inventory' después de .net/ para que cree una base de datos específica
const MONGO_URI = "mongodb+srv://daniel:daniel25@capacitacion.nxd7yl9.mongodb.net/tool_inventory?retryWrites=true&w=majority&appName=capacitacion&authSource=admin";

mongoose.connect(MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
})
.then(() => console.log('✅ Conectado a MongoDB Atlas'))
.catch(err => console.error('❌ Error de conexión:', err));

// --- MODELOS (ESQUEMAS DE DATOS) ---

// 1. Inventario
const ItemSchema = new mongoose.Schema({
    name: String,
    sku: String,
    type: String,
    stock: Number,
    total: Number
});
const Item = mongoose.model('Item', ItemSchema);

// 2. Préstamos (Tickets)
const LoanSchema = new mongoose.Schema({
    responsible: String,
    location: String,
    date: String,
    items: Array, // Guardamos el array del carrito
    signature: String, // Imagen en base64
    status: { type: String, default: 'Active' },
    returnDate: String
});
const Loan = mongoose.model('Loan', LoanSchema);

// --- RUTAS DE LA API ---

// GET: Obtener inventario
app.get('/api/inventory', async (req, res) => {
    try {
        const items = await Item.find();
        res.json(items);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST: Crear nuevo item
app.post('/api/inventory', async (req, res) => {
    try {
        const newItem = new Item(req.body);
        await newItem.save();
        res.json(newItem);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET: Obtener préstamos
app.get('/api/loans', async (req, res) => {
    try {
        // .sort({ _id: -1 }) hace que salgan los más nuevos primero
        const loans = await Loan.find().sort({ _id: -1 });
        res.json(loans);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST: Crear ticket de salida (Y actualizar stock)
app.post('/api/loans', async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        // 1. Guardar el ticket
        const loan = new Loan(req.body);
        await loan.save({ session });

        // 2. Restar stock de cada item
        for (const cartItem of req.body.items) {
            await Item.findByIdAndUpdate(
                cartItem._id, 
                { $inc: { stock: -cartItem.qty } },
                { session }
            );
        }

        await session.commitTransaction();
        res.json({ message: 'Ticket creado y stock actualizado', loan });
    } catch (err) {
        await session.abortTransaction();
        res.status(500).json({ error: err.message });
    } finally {
        session.endSession();
    }
});

// PUT: Devolver préstamo (Y sumar stock)
app.put('/api/loans/:id/return', async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const loan = await Loan.findById(req.params.id);
        if (!loan) throw new Error('Ticket no encontrado');
        if (loan.status === 'Returned') throw new Error('Ya devuelto');

        // 1. Actualizar ticket
        loan.status = 'Returned';
        loan.returnDate = new Date().toLocaleString();
        await loan.save({ session });

        // 2. Devolver stock
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

// Iniciar servidor
app.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});
