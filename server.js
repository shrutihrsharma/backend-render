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
  try {
    const sessionId = uuidv4().slice(0, 6).toUpperCase();
    const hostToken = uuidv4();

    sessions.set(sessionId, {
      players: [],
      phase: "WAITING",
      hostToken,
      hostId: null,
      question: "",
      buzzerEnabled: false,
      currentBuzzPlayerId: null,
    });

    res.json({ sessionId, hostToken });
  } catch (e) {
    console.error("CREATE ERROR:", e);
    res.status(500).send("Server error");
  }
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

    this.ROUNDS = [
    /* ================= GLOBAL + INDIA GK ================= */
    {
      name: "World & India Mix",
      questions: [
        {
          prompt:
            "Which country has the world’s largest high-speed rail network?",
          answer: "China",
        },
        {
          prompt: "Author of the famous book 'Rich Dad Poor Dad'",
          answer: "Robert Kiyosaki",
        },
        {
          prompt:
            "India’s first indigenously built aircraft carrier is named what?",
          answer: "INS Vikrant",
        },
        {
          prompt: "Which canal connects the Mediterranean Sea to the Red Sea?",
          answer: "Suez Canal",
        },
        {
          prompt: "Name 3 Nordic countries",
          answer: "Denmark, Norway, Sweden, Finland, Iceland",
        },
        {
          prompt:
            "Who is the current Minisiter of Agriculture and Farmers' Welfare and also Rural Development",
          answer: "Shivraj Singh Chouhan",
        },
        { prompt: "Author of book 1984?", answer: "George Orwell" },
        {
          prompt:
            "Which Indian city is known as the “Detroit of India” because of its automobile industry?",
          answer: "Chennai",
        },
        {
          prompt: "India’s first Nobel Prize in Physics was awarded to whom?",
          answer: "C.V Raman(1930)",
        },
        {
          prompt: "Name of the Largest cricket stadium in the world?",
          answer: "Narendra Modi Stadium, Ahmedabad",
        },
        {
          prompt:
            "Which Indian state is also widely known as 'Fort capital of India'? with over 350 plus forts.",
          answer: "Maharashtra",
        },
      ],
    },

    /* ================= FASHION ================= */
    {
      name: "Pop Culture & Fashion",
      questions: [
        {
          prompt:
            "'You have Castle Black. My watch has ended' — is a dialogue from which show?",
          answer: "Game of Thrones",
        },
        {
          prompt: "Michael Scott manages which fictional company?",
          answer: "Dunder Mifflin",
        },
        {
          prompt:
            "what is the full form of these genz lingos 'SMH', 'FRFR', 'NGL' ",
          answer: "Shaking my head, for real for real, not gonna lie.",
        },       
        { prompt: "'Zara' country of origin?", answer: "Spain" },
        { prompt: "'Uniqlo' country of origin?", answer: "Japan" },
        { prompt: "H&M full form?", answer: "Hennes & Mauritz" },
      ],
    },

    /* ================= IMAGE / LOGO ROUND ================= */
    {
      name: "Tech Titans & Logo Detective",
      questions: [
        {
          prompt: "Which Company is behind Kubernetes?",
          answer: "Google",
        },
        {
          prompt: "Who is the Linux kernel creator?",
          answer: "Linus Torvalds",
        },
        {
          prompt: "Kafka was originally built at which company?",
          answer: "LinkedIn",
        },        
        { prompt: "React creator company?", answer: "Facebook" },        
        {
          prompt: "Identify dev platform",
          answer: "GitLab",
          type: "image",
          mediaUrl: "que/fo123x.jpg",
        },
        {
          prompt: "Identify the logo",
          answer: "Slack",
          type: "image",
          mediaUrl: "que/slac456k.png",
        },
        {
          prompt: "Identify the logo",
          answer: "Xbox",
          type: "image",
          mediaUrl: "que/xbo123x.png",
        },
        {
          prompt: "Identify the logo",
          answer: "PostgreSQL",
          type: "image",
          mediaUrl: "que/elep789hant.png",
        },
        {
          prompt: "Identify the logo",
          answer: "Docker",
          type: "image",
          mediaUrl: "que/whal1234e.jpg",
        },
        {
          prompt: "Identify the logo",
          answer: "Jenkins",
          type: "image",
          mediaUrl: "que/jenkin123s.png",
        },
      ],
    },

    /* ================= MUSIC ROUND ================= */
    {
      name: "Sound Check",
      questions: [
        {
          prompt:
            "'I want the truth. You cant handle the truth!': is a dialogue from which famous movie",
          answer: "Few Good Men",
          type: "image",
          mediaUrl: "que/coloneljessep.png",
        },
        {
          prompt: "'How much time? An hour.' Identify the movie",
          answer: "Titanic",
          type: "image",
          mediaUrl: "que/sinking.png",
        },
        {
          prompt:
            "'To infinity and beyond!': which popular character said this and from which movie",
          answer: "Buzz Lightyear from Toy Story",
        },
        {
          prompt: "Identify the show/movie",
          answer: "Malgudi Days",
          type: "audio",
          mediaUrl: "que-audio/swami.mp3",
        },
        {
          prompt: "Identify the show/movie",
          answer: "The peaky blinders",
          type: "audio",
          mediaUrl: "que-audio/tshelby.mp3",
        },
        {
          prompt: "Identify the show/movie",
          answer: "The pursuit of happyness",
          type: "audio",
          mediaUrl: "que-audio/hired.mp3",
        },
      ],
    },
  ];
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
