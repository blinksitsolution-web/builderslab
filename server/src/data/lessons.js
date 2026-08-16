// The Builders' Lab — lesson video content.
// Module METADATA (title, ordering, which module is "in season") now lives
// in the database `modules` table so admins can edit it — see
// src/routes/modules.js and src/db/migrate.js for the seeded defaults.
// This file only holds the actual lesson videos/quizzes per module, since
// that's genuinely code-adjacent content (YouTube IDs, quiz banks) rather
// than something that needs a live admin UI.
//
// Replace youtubeId with your own unlisted uploads. `transcript` is optional
// context fed to the AI quiz generator (utils/ai.js) — the richer this is,
// the better the generated questions will be. Without it, the generator
// falls back to writing generic questions from the title/description alone.
const LESSONS = {
  "IOT-02": [
    {
      id: "L1",
      title: "Meet the Arduino Uno",
      youtubeId: "fJTEczcHVUY",
      durationSec: 300,
      transcript: "",
      resources: [
        { name: "Slide deck — Arduino basics.pdf", url: "/static-resources/iot-02/l1-slides.pdf" },
        { name: "Pin map reference.docx", url: "/static-resources/iot-02/l1-pinmap.docx" },
      ],
      quizBank: [
        { q: "What do you call the small board that runs your Arduino program?", options: ["Microcontroller", "Monitor", "Modem", "Mouse"], answer: 0 },
        { q: "Which pins on the Uno are used for digital input/output?", options: ["A0–A5 only", "0–13", "USB port", "Power jack"], answer: 1 },
        { q: "What software do you use to write and upload Arduino code?", options: ["Photoshop", "Arduino IDE", "Excel", "Chrome"], answer: 1 },
      ],
    },
    {
      id: "L2",
      title: "Reading a sensor",
      youtubeId: "fJTEczcHVUY",
      durationSec: 260,
      transcript: "",
      resources: [{ name: "Sensor wiring diagram.pdf", url: "/static-resources/iot-02/l2-wiring.pdf" }],
      quizBank: [
        { q: "What does an ultrasonic sensor measure?", options: ["Light level", "Distance", "Temperature", "Sound volume"], answer: 1 },
      ],
    },
  ],
  "PRG-01": [
    {
      id: "L1",
      title: "Blocks, loops & logic",
      youtubeId: "jXUZaf5D12A",
      durationSec: 240,
      transcript: "",
      resources: [{ name: "Scratch starter project.pdf", url: "/static-resources/prg-01/l1-starter.pdf" }],
      quizBank: [
        { q: "What is a 'loop' used for in programming?", options: ["Repeating a set of instructions", "Deleting your project", "Changing colours only", "Saving a file"], answer: 0 },
      ],
    },
  ],
};

function lessonsForCourse(moduleId) {
  return LESSONS[moduleId] || [];
}
function getLesson(moduleId, lessonId) {
  return lessonsForCourse(moduleId).find((l) => l.id === lessonId) || null;
}
function nextLessonId(moduleId, currentLessonId) {
  const lessons = lessonsForCourse(moduleId);
  const idx = lessons.findIndex((l) => l.id === currentLessonId);
  const next = lessons[idx + 1];
  return next ? next.id : currentLessonId;
}

module.exports = { LESSONS, lessonsForCourse, getLesson, nextLessonId };
