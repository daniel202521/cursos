const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));

// --- CONEXIÓN ---
const MONGO_URI = "mongodb+srv://daniel:daniel25@capacitacion.nxd7yl9.mongodb.net/tool_inventory?retryWrites=true&w=majority&appName=capacitacion&authSource=admin";

mongoose.connect(MONGO_URI)
.then(() => console.log('✅ Conectado a MongoDB Atlas'))
.catch(err => console.error('❌ Error de conexión:', err));

// --- MODELOS ---
const ItemSchema = new mongoose.Schema({
    name: String,
    brand: String,
    sku: String,
    type: String,
    stock: Number, // Lo que hay disponible en bodega
    total: Number  // Lo que posees en total (Stock + Prestado)
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

const HistorySchema = new mongoose.Schema({
    action: String,
    description: String,
    date: String,
    timestamp: { type: Date, default: Date.now }
});
const History = mongoose.model('History', HistorySchema);

// --- RUTAS ---

// GET: Inventario
app.get('/api/inventory', async (req, res) => {
    try {
        const items = await Item.find();
        res.json(items);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET: Historial
app.get('/api/history', async (req, res) => {
    try {
        const history = await History.find().sort({ timestamp: -1 }).limit(100);
        res.json(history);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST: Crear item
app.post('/api/inventory', async (req, res) => {
    try {
        let { name, brand, sku, type, stock } = req.body;

        if (!sku || sku.trim() === '') {
            const prefix = name ? name.substring(0, 2).toUpperCase() : 'XX';
            const randomNum = Math.floor(1000 + Math.random() * 9000); 
            sku = `${prefix}${randomNum}`;
        }

        // Al crear, el total es igual al stock inicial
        const newItem = new Item({ name, brand, sku, type, stock, total: stock });
        await newItem.save();

        await new History({
            action: 'Alta',
            description: `Nuevo item: ${name} (${stock} u.)`,
            date: new Date().toLocaleString()
        }).save();

        res.json(newItem);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE: Eliminar Item (NUEVO)
app.delete('/api/inventory/:id', async (req, res) => {
    try {
        const item = await Item.findById(req.params.id);
        if (!item) return res.status(404).json({ error: 'Item no encontrado' });

        // PROTECCIÓN: No permitir borrar si hay items prestados (Stock < Total)
        // Opcional: podrías permitirlo pero es arriesgado para la integridad de datos
        if (item.stock < item.total) {
            return res.status(400).json({ error: 'No se puede eliminar: Hay herramientas prestadas. Recupéralas antes de borrar.' });
        }

        await Item.findByIdAndDelete(req.params.id);

        await new History({
            action: 'Baja',
            description: `Item eliminado permanentemente: ${item.name}`,
            date: new Date().toLocaleString()
        }).save();

        res.json({ message: 'Eliminado' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT: Editar Item (NUEVO)
app.put('/api/inventory/:id', async (req, res) => {
    try {
        const { name, brand, sku, type, total } = req.body; // El usuario edita el TOTAL
        const item = await Item.findById(req.params.id);
        if (!item) return res.status(404).json({ error: 'Item no encontrado' });

        const oldTotal = item.total || item.stock;
        const newTotal = parseInt(total);
        const diff = newTotal - oldTotal; // Diferencia (ej: Tenía 10, ahora 12 -> diff +2)

        // Actualizamos datos básicos
        item.name = name;
        item.brand = brand;
        item.sku = sku;
        item.type = type;
        
        // Ajuste inteligente de stock
        item.total = newTotal;
        item.stock = item.stock + diff; // El stock disponible sube o baja según el ajuste del total

        if (item.stock < 0) return res.status(400).json({ error: 'El stock disponible no puede ser negativo. Revisa la cantidad total.' });

        await item.save();

        await new History({
            action: 'Edición',
            description: `Item editado: ${name}. Total ajustado de ${oldTotal} a ${newTotal}`,
            date: new Date().toLocaleString()
        }).save();

        res.json(item);
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

// POST: Crear ticket
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

        const itemCount = req.body.items.reduce((acc, i) => acc + i.qty, 0);
        const itemNames = req.body.items.map(i => i.name).join(', ');
        await new History({
            action: 'Salida',
            description: `Prestado a: ${req.body.responsible} (${itemCount} items: ${itemNames})`,
            date: new Date().toLocaleString()
        }).save({ session });

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

        await new History({
            action: 'Devolución',
            description: `Devuelto por: ${loan.responsible}`,
            date: new Date().toLocaleString()
        }).save({ session });

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
