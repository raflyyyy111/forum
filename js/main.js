document.addEventListener('DOMContentLoaded', () => {
    // Seleksi Elemen DOM
    const myIdEl = document.getElementById('my-id');
    const statusEl = document.getElementById('status');
    const peerIdInput = document.getElementById('peer-id-input');
    const connectButton = document.getElementById('connect-button');
    const chatBox = document.getElementById('chat-box');
    const secretKeyInput = document.getElementById('secret-key-input');
    const startSecureButton = document.getElementById('start-secure-button');
    const chatLog = document.getElementById('chat-log');
    const messageInput = document.getElementById('message-input');
    const sendButton = document.getElementById('send-button');

    // State Aplikasi
    let peer = null;
    let conn = null;
    let cryptoKey = null;

    function log(message, type = 'system') {
        const p = document.createElement('p');
        p.textContent = message;
        p.className = type;
        chatLog.appendChild(p);
        chatLog.scrollTop = chatLog.scrollHeight;
    }

    // Inisialisasi PeerJS
    function initialize() {
        peer = new Peer(); // PeerJS akan otomatis terhubung ke signaling servernya sendiri

        peer.on('open', (id) => {
            myIdEl.textContent = id;
            statusEl.textContent = "Menunggu koneksi...";
        });

        peer.on('connection', (connection) => {
            conn = connection;
            statusEl.textContent = `Terhubung dengan ${conn.peer}`;
            chatBox.style.display = 'block';
            setupConnectionEvents();
        });

        peer.on('error', (err) => {
            console.error('PeerJS Error:', err);
            statusEl.textContent = `Error: ${err.type}. Coba refresh halaman.`;
        });
    }

    // Mengatur event listener untuk koneksi yang sudah terbentuk
    function setupConnectionEvents() {
        conn.on('data', (data) => {
            if (cryptoKey) {
                decryptMessage(data);
            } else {
                log(`Pesan mentah diterima: ${data}`, 'peer');
            }
        });

        conn.on('close', () => {
            statusEl.textContent = "Koneksi terputus.";
            log('Teman terputus.');
            chatBox.style.display = 'none';
        });
    }

    // Event listener untuk tombol
    connectButton.addEventListener('click', () => {
        const peerId = peerIdInput.value.trim();
        if (peerId) {
            statusEl.textContent = `Menghubungkan ke ${peerId}...`;
            conn = peer.connect(peerId);
            setupConnectionEvents();
            chatBox.style.display = 'block';
        }
    });

    startSecureButton.addEventListener('click', async () => {
        const secret = secretKeyInput.value;
        if (secret.length < 8) {
            alert('Kata sandi minimal 8 karakter.');
            return;
        }
        cryptoKey = await deriveKeyFromPassword(secret);
        log("Sesi enkripsi dimulai. Pesan sekarang aman.");
        messageInput.disabled = false;
        sendButton.disabled = false;
        secretKeyInput.disabled = true;
        startSecureButton.disabled = true;
    });

    sendButton.addEventListener('click', sendMessage);
    messageInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendMessage();
    });

    // Fungsi Enkripsi & Dekripsi
    async function deriveKeyFromPassword(password) {
        const encoder = new TextEncoder();
        const keyMaterial = await window.crypto.subtle.importKey(
            'raw', encoder.encode(password), { name: 'PBKDF2' }, false, ['deriveKey']
        );
        return window.crypto.subtle.deriveKey(
            { name: 'PBKDF2', salt: encoder.encode("MRVX_SALT_V4"), iterations: 100000, hash: 'SHA-256' },
            keyMaterial, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
        );
    }

    async function sendMessage() {
        const message = messageInput.value;
        if (!message.trim() || !cryptoKey) return;

        const encoder = new TextEncoder();
        const iv = window.crypto.getRandomValues(new Uint8Array(12));
        const encrypted = await window.crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: iv }, cryptoKey, encoder.encode(message)
        );
        
        // Kirim IV bersama dengan ciphertext
        const payload = {
            iv: Array.from(iv),
            data: Array.from(new Uint8Array(encrypted))
        };

        conn.send(JSON.stringify(payload));
        log(`Anda: ${message}`, 'me');
        messageInput.value = '';
    }

    async function decryptMessage(payload) {
        try {
            const parsed = JSON.parse(payload);
            const iv = new Uint8Array(parsed.iv);
            const data = new Uint8Array(parsed.data);

            const decrypted = await window.crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: iv }, cryptoKey, data
            );

            const message = new TextDecoder().decode(decrypted);
            log(`Teman: ${message}`, 'peer');
        } catch (err) {
            log("Gagal mendekripsi pesan. Pastikan kata sandi sama.");
            console.error("Decryption error:", err);
        }
    }

    // Jalankan aplikasi
    initialize();
});
