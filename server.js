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
const sessions = new Map(); // replaces Durable Objects
const axios = require("axios");
const AdmZip = require("adm-zip");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const upload = multer({
  dest: "temp/",
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB max
});

app.post("/load-pack-from-url/:sessionId", async (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).send("Session not found");

  const url = req.body.url;

  try {
    const response = await axios({
      method: "GET",
      url,
      responseType: "arraybuffer",
    });

    const zipPath = path.join(__dirname, "temp.zip");
    fs.writeFileSync(zipPath, response.data);

    const extractPath = path.join(__dirname, "uploads", req.params.sessionId);
    fs.mkdirSync(extractPath, { recursive: true });

    const zip = new AdmZip(zipPath);
    zip.extractAllTo(extractPath, true);

    const quizJson = JSON.parse(
      fs.readFileSync(path.join(extractPath, "quiz.json"), "utf8"),
    );

    if (!Array.isArray(quizJson)) {
      return res.status(400).send("Invalid quiz format");
    }

    for (const round of quizJson) {
      if (!round.name || !Array.isArray(round.questions)) {
        return res.status(400).send("Invalid round format");
      }

      for (const q of round.questions) {
        if (!q.prompt || !q.answer) {
          return res.status(400).send("Invalid question format");
        }

        if (q.type && !["image", "audio", "video"].includes(q.type)) {
          return res.status(400).send("Invalid media type");
        }
        if (q.mediaFile && q.mediaFile.includes("..")) {
          return res.status(400).send("Invalid file path");
        }

        if (q.mediaUrl && q.mediaUrl.includes("..")) {
          return res.status(400).send("Invalid file path");
        }
      }
    }

    quizJson.forEach((round) => {
      round.questions.forEach((q) => {
        if (q.mediaFile) {
          q.mediaUrl = `/media/${req.params.sessionId}/${q.mediaFile}`;
          delete q.mediaFile;
        }
        if (q.mediaUrl && !q.mediaUrl.startsWith("/media/")) {
          q.mediaUrl = `/media/${req.params.sessionId}/${q.mediaUrl}`;
        }
      });
    });

    session.ROUNDS = quizJson;
    session.packUploaded = true;

    res.json({ status: "Quiz pack loaded successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).send("Failed to download quiz pack");
  }
});

// Upload quiz pack (zip file with quiz.json and media)
app.post("/upload-pack/:sessionId", upload.single("file"), (req, res) => {
  if (!req.file.originalname.endsWith(".zip")) {
    return res.status(400).send("Only ZIP files allowed");
  }
  const sessionId = req.params.sessionId;
  const session = sessions.get(sessionId);

  if (!session) return res.status(404).send("Session not found");

  const zip = new AdmZip(req.file.path);
  const extractPath = path.join(__dirname, "uploads", sessionId);

  fs.mkdirSync(extractPath, { recursive: true });
  zip.extractAllTo(extractPath, true);

  const quizJsonPath = path.join(extractPath, "quiz.json");

  if (!fs.existsSync(quizJsonPath)) {
    return res.status(400).send("quiz.json missing");
  }

  const rounds = JSON.parse(fs.readFileSync(quizJsonPath, "utf8"));
  if (!Array.isArray(rounds)) {
    return res.status(400).send("Invalid quiz format");
  }

  for (const round of rounds) {
    if (!round.name || !Array.isArray(round.questions)) {
      return res.status(400).send("Invalid round format");
    }

    for (const q of round.questions) {
      if (!q.prompt || !q.answer) {
        return res.status(400).send("Invalid question format");
      }

      if (q.type && !["image", "audio", "video"].includes(q.type)) {
        return res.status(400).send("Invalid media type");
      }
      if (q.mediaFile && q.mediaFile.includes("..")) {
        return res.status(400).send("Invalid file path");
      }

      if (q.mediaUrl && q.mediaUrl.includes("..")) {
        return res.status(400).send("Invalid file path");
      }
    }
  }

  // rewrite mediaFile -> mediaUrl
  rounds.forEach((round) => {
    round.questions.forEach((q) => {
      if (q.mediaFile) {
        q.mediaUrl = `/media/${sessionId}/${q.mediaFile}`;
        delete q.mediaFile;
      }

      if (q.mediaUrl && !q.mediaUrl.startsWith("/media/")) {
        q.mediaUrl = `/media/${sessionId}/${q.mediaUrl}`;
      }
    });
  });

  session.ROUNDS = rounds;
  session.packUploaded = true;

  res.json({ status: "Quiz pack uploaded successfully" });
});

// Serve media files
app.use("/media", express.static(path.join(__dirname, "uploads")));

// ===== CREATE SESSION =====
app.get("/create", (req, res) => {
  try {
    const sessionId = uuidv4().slice(0, 6).toUpperCase();
    const session = new GameSession(sessionId);

    sessions.set(sessionId, session);

    res.json({
      sessionId,
      hostToken: session.hostToken,
    });
  } catch (e) {
    console.error("CREATE ERROR:", e);
    res.status(500).send("Server error");
  }
});

// ===== WEBSOCKET =====
wss.on("connection", (ws, req) => {
  const sessionId = req.url.split("/").pop();

  const session = sessions.get(sessionId);
  if (!session) {
    ws.close();
    return;
  }

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
    this.packUploaded = false;

    this.teams = ["🔥 Fire", "🌍 Earth", "🌊 Water"];

    this.ROUNDS = []; // to be populated when quiz pack is uploaded
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

      if (data.hostToken === this.hostToken) this.hostId = data.playerId;

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
      if (!this.currentBuzzPlayerId) return;

      const winner = this.players.find(
        (p) => p.id === this.currentBuzzPlayerId,
      );

      if (winner) winner.score++;

      this.buzzerEnabled = false; // disable buzzer
      this.revealAnswer = this.currentAnswer;
      this.phase = "ANSWER_REVEAL";

      this.currentBuzzPlayerId = null;

      this.broadcast(); // show answer

      setTimeout(() => {
        this.phase = "WAITING";
        this.revealAnswer = null;
        this.broadcast(); // move to waiting
      }, 4000);
    }

    if (data.type === "MARK_WRONG" && data.playerId === this.hostId) {
      this.phase = "QUESTION_LIVE";
      this.currentBuzzPlayerId = null;
      this.buzzerEnabled = true;

      this.broadcast();
    }

    if (data.type === "SKIP_QUESTION" && data.playerId === this.hostId) {
      this.revealAnswer = this.currentAnswer;
      this.phase = "ANSWER_REVEAL";
      this.buzzerEnabled = false;
      this.currentBuzzPlayerId = null;

      this.broadcast();

      setTimeout(() => {
        this.phase = "WAITING";
        this.revealAnswer = null;
        this.broadcast();
      }, 4000);
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
      this.question = "";
      this.currentQuestion = null;
      this.currentAnswer = "";
      this.buzzerEnabled = false;
      this.currentBuzzPlayerId = null;
      this.revealAnswer = null;

      this.topScore = Math.max(...this.players.map((p) => p.score));
      this.individualWinner = this.players.find(
        (p) => p.score === this.topScore,
      );

      this.broadcast();
    }

    if (data.type === "RESET_GAME" && data.playerId === this.hostId) {
      this.phase = "WAITING";
      this.roundIndex = 0;
      this.questionIndex = -1;
      this.players.forEach((p) => (p.score = 0));
      this.individualWinner = null;
      this.topScore = 0;
      this.question = "";
      this.currentQuestion = null;
      this.currentAnswer = "";
      this.buzzerEnabled = false;

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
      packUploaded: this.packUploaded,
    });

    this.sessions.forEach((ws) => ws.send(payload));
  }
}

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log("Server running on port", PORT));
