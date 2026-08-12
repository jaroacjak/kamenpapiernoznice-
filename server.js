const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

const rooms = new Map();

app.use(express.static(path.join(__dirname)));

app.get("/health", (req, res) => {
    res.json({
        online: true,
        rooms: rooms.size
    });
});

function send(ws, data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }
}

function createCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    let code;

    do {
        code = "";

        for (let i = 0; i < 6; i++) {
            code += chars[Math.floor(Math.random() * chars.length)];
        }

    } while (rooms.has(code));

    return code;
}

function winner(a, b) {

    if (a === b) {
        return "draw";
    }

    if (
        (a === "kamen" && b === "noznice") ||
        (a === "papier" && b === "kamen") ||
        (a === "noznice" && b === "papier")
    ) {
        return "player1";
    }

    return "player2";
}

function resultText(result, player) {

    if (result === "draw") {
        return "🤝 Remíza!";
    }

    if (result === player) {
        return "🎉 Vyhral si kolo!";
    }

    return "😔 Prehral si kolo!";
}

wss.on("connection", (ws) => {

    ws.room = null;
    ws.player = null;

    send(ws, {
        type: "connected"
    });

    ws.on("message", (raw) => {

        let data;

        try {
            data = JSON.parse(raw.toString());
        } catch {
            send(ws, {
                type: "error",
                message: "Neplatná správa."
            });
            return;
        }

        /* =========================
           VYTVORIŤ MIESTNOSŤ
        ========================= */

        if (data.type === "create") {

            const code = createCode();

            const room = {
                code: code,

                players: [],

                moves: {},

                round: 1,

                score: {
                    player1: 0,
                    player2: 0
                }
            };

            rooms.set(code, room);

            ws.room = code;
            ws.player = 1;

            room.players.push(ws);

            send(ws, {
                type: "roomCreated",
                room: code
            });

            return;
        }

        /* =========================
           PRIPOJIŤ SA
        ========================= */

        if (data.type === "join") {

            const code =
                String(data.room || "")
                    .trim()
                    .toUpperCase();

            const room = rooms.get(code);

            if (!room) {

                send(ws, {
                    type: "error",
                    message: "Miestnosť s týmto kódom neexistuje."
                });

                return;
            }

            if (room.players.length >= 2) {

                send(ws, {
                    type: "error",
                    message: "Miestnosť je už plná."
                });

                return;
            }

            ws.room = code;
            ws.player = 2;

            room.players.push(ws);

            /* OZNÁMIME OBOCH HRÁČOM ZAČIATOK */

            room.players.forEach((player) => {

                send(player, {
                    type: "gameStart",
                    room: code
                });

            });

            return;
        }

        /* =========================
           ŤAH
        ========================= */

        if (data.type === "move") {

            const room = rooms.get(ws.room);

            if (!room) {
                return;
            }

            if (room.players.length !== 2) {

                send(ws, {
                    type: "error",
                    message: "Čaká sa na druhého hráča."
                });

                return;
            }

            const allowedMoves = [
                "kamen",
                "papier",
                "noznice"
            ];

            if (!allowedMoves.includes(data.move)) {
                return;
            }

            /* Zabráni dvojitému kliknutiu */

            if (room.moves[ws.player]) {
                return;
            }

            room.moves[ws.player] = data.move;

            /* ČAKÁME NA OBOCH HRÁČOV */

            if (
                !room.moves[1] ||
                !room.moves[2]
            ) {

                send(ws, {
                    type: "waiting"
                });

                return;
            }

            const move1 = room.moves[1];
            const move2 = room.moves[2];

            const result = winner(move1, move2);

            /* SKÓRE */

            if (result === "player1") {
                room.score.player1++;
            }

            if (result === "player2") {
                room.score.player2++;
            }

            /* POSLEDNÉ KOLO? */

            const finalRound = room.round >= 3;

            room.players.forEach((player) => {

                const p1 = player.player === 1;

                const myMove = p1
                    ? move1
                    : move2;

                const opponentMove = p1
                    ? move2
                    : move1;

                const myScore = p1
                    ? room.score.player1
                    : room.score.player2;

                const opponentScore = p1
                    ? room.score.player2
                    : room.score.player1;

                send(player, {
                    type: "roundResult",

                    round: room.round,

                    myMove: myMove,

                    opponentMove: opponentMove,

                    myScore: myScore,

                    opponentScore: opponentScore,

                    result: resultText(
                        result,
                        p1
                            ? "player1"
                            : "player2"
                    )
                });

            });

            /* =========================
               KONIEC HRY
            ========================= */

            if (finalRound) {

                setTimeout(() => {

                    room.players.forEach((player) => {

                        const p1 =
                            player.player === 1;

                        send(player, {
                            type: "gameOver",

                            myScore: p1
                                ? room.score.player1
                                : room.score.player2,

                            opponentScore: p1
                                ? room.score.player2
                                : room.score.player1
                        });

                    });

                    rooms.delete(room.code);

                }, 1500);

                return;
            }

            /* ĎALŠIE KOLO */

            room.round++;

            room.moves = {};

            return;
        }
    });

    /* =========================
       ODPOJENIE
    ========================= */

    ws.on("close", () => {

        if (!ws.room) {
            return;
        }

        const room = rooms.get(ws.room);

        if (!room) {
            return;
        }

        room.players.forEach((player) => {

            if (player !== ws) {

                send(player, {
                    type: "error",
                    message: "Druhý hráč sa odpojil."
                });

                try {
                    player.close();
                } catch {}
            }

        });

        rooms.delete(ws.room);
    });
});

server.listen(PORT, "0.0.0.0", () => {

    console.log(
        `Server beží na porte ${PORT}`
    );

});
