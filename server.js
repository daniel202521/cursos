const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bodyParser = require('body-parser');
const http = require('http'); // Necesario para Socket.io
const { Server } = require('socket.io'); // Importar Socket.io

const app = express();
const PORT = process.env.PORT || 5000;

// Configuración de Middlewares
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));

// --- CONFIGURACIÓN SOCKET.IO ---
const server = http.createServer(app); // Creamos servidor HTTP a partir de Express
const io = new Server(server, {
    cors: {
        origin: "*", // Permitir conexiones desde cualquier lugar (tu PC, Render, etc)
        methods: ["GET", "POST", "PUT", "DELETE"]
    }
});

io.on('connection', (socket) => {
    console.log('🔌 Nuevo cliente conectado:', socket.id);
    
    socket.on('disconnect', () => {
        console.log('❌ Cliente desconectado:', socket.id);
    });
});

// --- CONEXIÓN MONGODB ---
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

const HistorySchema = new mongoose.Schema({
    action: String,
    description: String,
    date: String,
    timestamp: { type: Date, default: Date.now }
});
const History = mongoose.model('History', HistorySchema);

// --- RUTAS API (Con Emisión de Eventos) ---

app.get('/api/inventory', async (req, res) => {
    try {
        const items = await Item.find();
        res.json(items);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/history', async (req, res) => {
    try {
        const history = await History.find().sort({ timestamp: -1 }).limit(100);
        res.json(history);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/inventory', async (req, res) => {
    try {
        let { name, brand, sku, type, stock } = req.body;
        if (!sku || sku.trim() === '') {
            const prefix = name ? name.substring(0, 2).toUpperCase() : 'XX';
            const randomNum = Math.floor(1000 + Math.random() * 9000); 
            sku = `${prefix}${randomNum}`;
        }
        const newItem = new Item({ name, brand, sku, type, stock, total: stock });
        await newItem.save();

        await new History({
            action: 'Alta',
            description: `Nuevo item: ${name} (${stock} u.)`,
            date: new Date().toLocaleString()
        }).save();

        // 🔥 AVISAR A TODOS: INVENTARIO ACTUALIZADO
        io.emit('refresh_inventory'); 
        io.emit('refresh_history');

        res.json(newItem);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/inventory/:id', async (req, res) => {
    try {
        const item = await Item.findById(req.params.id);
        if (!item) return res.status(404).json({ error: 'Item no encontrado' });
        if (item.stock < item.total) return res.status(400).json({ error: 'No se puede eliminar: Hay herramientas prestadas.' });

        await Item.findByIdAndDelete(req.params.id);

        await new History({
            action: 'Baja',
            description: `Item eliminado: ${item.name}`,
            date: new Date().toLocaleString()
        }).save();

        // 🔥 AVISAR CAMBIOS
        io.emit('refresh_inventory');
        io.emit('refresh_history');

        res.json({ message: 'Eliminado' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/inventory/:id', async (req, res) => {
    try {
        const { name, brand, sku, type, total } = req.body;
        const item = await Item.findById(req.params.id);
        if (!item) return res.status(404).json({ error: 'Item no encontrado' });

        const oldTotal = item.total || item.stock;
        const newTotal = parseInt(total);
        const diff = newTotal - oldTotal;

        item.name = name;
        item.brand = brand;
        item.sku = sku;
        item.type = type;
        item.total = newTotal;
        item.stock = item.stock + diff;

        if (item.stock < 0) return res.status(400).json({ error: 'El stock disponible no puede ser negativo.' });

        await item.save();

        await new History({
            action: 'Edición',
            description: `Item editado: ${name}. Total: ${newTotal}`,
            date: new Date().toLocaleString()
        }).save();

        // 🔥 AVISAR CAMBIOS
        io.emit('refresh_inventory');
        io.emit('refresh_history');

        res.json(item);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/loans', async (req, res) => {
    try {
        const loans = await Loan.find().sort({ _id: -1 });
        res.json(loans);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

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
        await new History({
            action: 'Salida',
            description: `Prestado a: ${req.body.responsible} (${itemCount} items)`,
            date: new Date().toLocaleString()
        }).save({ session });

        await session.commitTransaction();
        
        // 🔥 AVISAR A TODOS: SE MOVIÓ EL INVENTARIO Y HAY NUEVO PRÉSTAMO
        io.emit('refresh_inventory');
        io.emit('refresh_loans');
        io.emit('refresh_history');

        res.json({ message: 'Ticket creado', loan });
    } catch (err) {
        await session.abortTransaction();
        res.status(500).json({ error: err.message });
    } finally { session.endSession(); }
});

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

        // 🔥 AVISAR A TODOS
        io.emit('refresh_inventory');
        io.emit('refresh_loans');
        io.emit('refresh_history');

        res.json({ message: 'Devolución procesada', loan });
    } catch (err) {
        await session.abortTransaction();
        res.status(500).json({ error: err.message });
    } finally { session.endSession(); }
});

// IMPORTANTE: Usar server.listen en lugar de app.listen para que funcione Socket.io
server.listen(PORT, () => {
    console.log(`🚀 Servidor (con WebSockets) corriendo en el puerto ${PORT}`);
});
