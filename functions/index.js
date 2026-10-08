const {setGlobalOptions} = require("firebase-functions");
const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const https = require("https");
// Securely access the OpenRouter API key from Firebase Secret Manager.
const OPENROUTER_API_KEY = defineSecret("OPENROUTER_API_KEY");

// Cost and performance control.
setGlobalOptions({
  maxInstances: 10,
  region: "asia-south1",
});

// CoachLens AI
exports.coachLensAI = onCall(
  {
    secrets: [OPENROUTER_API_KEY],  },
  async (request) => {
    // Only authenticated CoachLens users can use the AI.
    if (!request.auth) {
      throw new HttpsError(
        "unauthenticated",
        "You must be signed in to use CoachLens AI."
      );
    }

    const prompt = request.data?.prompt;

    if (!prompt || typeof prompt !== "string") {
      throw new HttpsError(
        "invalid-argument",
        "A valid prompt is required."
      );
    }

    try {
      const apiKey = OPENROUTER_API_KEY.value();

      const requestBody = JSON.stringify({
        model: "openrouter/free",
        messages: [
          {
            role: "system",
            content:
              "You are CoachLens AI, an expert cricket coaching assistant. " +
              "Provide practical, evidence-informed and coach-friendly answers. " +
              "Focus on player development, cricket technique, training, " +
              "performance analysis, match analysis and coaching methodology. " +
              "Use clear structure and actionable recommendations.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: 0.4,
        max_tokens: 2000,
      });

      const data = await new Promise((resolve, reject) => {
        const options = {
          hostname: "openrouter.ai",
          path: "/api/v1/chat/completions",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
            "Content-Length": Buffer.byteLength(requestBody),
          },
        };

        const req = https.request(options, (res) => {
          let responseData = "";

          res.on("data", (chunk) => {
            responseData += chunk;
          });

          res.on("end", () => {
            try {
              const parsed = JSON.parse(responseData);
              if (res.statusCode >= 200 && res.statusCode < 300) {
                resolve(parsed);
              } else {
                reject(new Error(
                  parsed?.error?.message || "OpenRouter API request failed."
                ));
              }
            } catch (parseError) {
              reject(new Error("Failed to parse OpenRouter response."));
            }
          });
        });

        req.on("error", (error) => {
          reject(error);
        });

        req.write(requestBody);
        req.end();
      });

      const answer = data?.choices?.[0]?.message?.content || "";

      return {
        success: true,
        answer: answer,
      };
    } catch (error) {
      logger.error("OpenRouter API error", error);

      throw new HttpsError(
        "internal",
        "CoachLens AI could not process the request."
      );
    }
  }
);