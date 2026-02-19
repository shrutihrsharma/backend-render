const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const sessions = {}; // replaces Durable Objects

// ===== CREATE SESSION =====
app.get("/create", (req, res) => {
  const sessionId = uuidv4().slice(0, 6).toUpperCase();

  sessions[sessionId] = new GameSession(sessionId);

  res.json({
    sessionId,
    hostToken: sessions[sessionId].hostToken,
  });
});

// ===== WEBSOCKET =====
wss.on("connection", (ws, req) => {
  const sessionId = req.url.split("/").pop();

  const session = sessions[sessionId];
  if (!session) return ws.close();

  session.addConnection(ws);
});

class GameSession {
  constructor(sessionId) {
    this.sessionId = sessionId;

    this.phase = "WAITING";
    this.currentBuzzPlayerId = null;
    this.buzzerEnabled = false;

    this.question = "";
    this.hostId = null;
    this.hostToken = uuidv4();

    this.players = [];
    this.sessions = new Map();

    this.roundIndex = 0;
    this.questionIndex = -1;
    this.currentQuestion = null;
    this.currentAnswer = "";
    this.currentRoundName = "";

    this.revealAnswer = null;
    this.topScore = 0;
    this.individualWinner = null;

    this.teams = ["🔥 Fire", "🌍 Earth", "🌊 Water"];

    this.ROUNDS = YOUR_ROUNDS_ARRAY_HERE;
  }

  addConnection(ws) {
    ws.on("message", (msg) => {
      const data = JSON.parse(msg);
      this.handleMessage(ws, data);
    });

    ws.on("close", () => {
      this.sessions.delete(ws);
    });
  }

  handleMessage(ws, data) {
    if (data.type === "JOIN") {
      this.sessions.set(data.playerId, ws);

      let existing = this.players.find((p) => p.name === data.name);

      if (existing) existing.id = data.playerId;
      else {
        this.players.push({
          id: data.playerId,
          name: data.name,
          team: this.assignTeam(),
          score: 0,
        });
      }

      if (data.hostToken === this.hostToken)
        this.hostId = data.playerId;

      this.broadcast();
    }

    if (data.type === "BUZZ" && this.phase === "QUESTION_LIVE") {
      if (!this.buzzerEnabled || this.currentBuzzPlayerId) return;

      this.currentBuzzPlayerId = data.playerId;
      this.buzzerEnabled = false;
      this.phase = "BUZZ_LOCKED";

      this.broadcast();
    }

    if (data.type === "MARK_CORRECT" && data.playerId === this.hostId) {
      const winner = this.players.find(
        (p) => p.id === this.currentBuzzPlayerId
      );

      if (winner) winner.score++;

      this.revealAnswer = this.currentAnswer;
      this.phase = "ANSWER_REVEAL";

      setTimeout(() => {
        this.phase = "WAITING";
        this.revealAnswer = null;
        this.broadcast();
      }, 4000);

      this.currentBuzzPlayerId = null;
      this.broadcast();
    }

    if (data.type === "NEXT_QUESTION" && data.playerId === this.hostId) {
      const round = this.ROUNDS[this.roundIndex];

      this.questionIndex++;

      if (this.questionIndex >= round.questions.length) {
        this.roundIndex++;
        this.questionIndex = 0;
      }

      const q = this.ROUNDS[this.roundIndex]?.questions[this.questionIndex];
      if (!q) return;

      this.currentQuestion = q;
      this.currentAnswer = q.answer;
      this.question = q.prompt;
      this.currentRoundName = this.ROUNDS[this.roundIndex].name;

      this.phase = "QUESTION_DISPLAYED";
      this.buzzerEnabled = false;
      this.broadcast();

      setTimeout(() => {
        this.phase = "QUESTION_LIVE";
        this.buzzerEnabled = true;
        this.broadcast();
      }, 500);
    }

    if (data.type === "END_GAME") {
      this.phase = "ENDED";

      this.topScore = Math.max(...this.players.map((p) => p.score));
      this.individualWinner =
        this.players.find((p) => p.score === this.topScore);

      this.broadcast();
    }
  }

  assignTeam() {
    const counts = {};
    this.teams.forEach((t) => (counts[t] = 0));
    this.players.forEach((p) => counts[p.team]++);
    return Object.entries(counts).sort((a, b) => a[1] - b[1])[0][0];
  }

  broadcast() {
    const payload = JSON.stringify({
      type: "STATE",
      phase: this.phase,
      question: this.question,
      questionType: this.currentQuestion?.type || "text",
      mediaUrl: this.currentQuestion?.mediaUrl || null,
      answer: this.revealAnswer,
      roundName: this.currentRoundName,
      players: this.players,
      hostId: this.hostId,
      buzzerEnabled: this.buzzerEnabled,
      currentBuzzPlayerId: this.currentBuzzPlayerId,
      individualWinner: this.individualWinner,
      topScore: this.topScore,
    });

    this.sessions.forEach((ws) => ws.send(payload));
  }
}

const PORT = process.env.PORT || 10000;
server.listen(PORT, () =>
  console.log("Server running on port", PORT)
);
