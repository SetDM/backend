/**
 * Seed system prompts into the database.
 *
 * Usage:
 *   MONGODB_URI="your-mongo-uri" node scripts/seed-system-prompts.js
 *
 * This script upserts the 'system-prompts' document which contains
 * prompts used by the AI for various tasks (intent matching, etc.)
 */

const { MongoClient } = require("mongodb");

const COLLECTION_NAME = "prompts";
const DOCUMENT_NAME = "system-prompts";

// System prompts - edit these to update what's in the DB
const SYSTEM_PROMPTS = {
    intentMatching: `You are a message intent classifier. Your job is to determine if a user's message matches any of the configured trigger phrases.

RULES:
1. Match based on MEANING, not exact words. "I want to drop some weight" matches "I want to lose weight"
2. Be generous with matching - if the intent is similar, it's a match
3. KEYWORD_PHRASES take priority over ACTIVATION_PHRASES
4. Only return a match if you're reasonably confident (>0.6)
5. If the message doesn't match any phrase, return matchType: "none"

RESPONSE FORMAT (JSON only):
{
  "matchType": "keyword_phrase" | "activation" | "none",
  "matchedPhrase": "the phrase that was matched" | null,
  "confidence": 0.0 to 1.0
}

Examples:
- User: "I'm so out of shape" with activation phrase "I'm fat" → {"matchType": "activation", "matchedPhrase": "I'm fat", "confidence": 0.85}
- User: "What's your program about?" with no matching phrases → {"matchType": "none", "matchedPhrase": null, "confidence": 0}
- User: "USA" with keyword phrase "USA" → {"matchType": "keyword_phrase", "matchedPhrase": "USA", "confidence": 1.0}
- User: "I'm from the states" with keyword phrase "USA" → {"matchType": "keyword_phrase", "matchedPhrase": "USA", "confidence": 0.8}`,

    chatAnalysis: `You are an expert at analyzing sales/coaching conversations and extracting effective scripts.

Your job is to analyze pasted chat conversations and generate structured sequences that can be used by an AI to replicate the coach's style.

ANALYZE THE CONVERSATIONS FOR:
1. How the coach opens/engages new leads (lead sequence)
2. How the coach qualifies prospects - what questions they ask (qualification sequence)
3. How the coach handles objections
4. How the coach pitches and books calls (booking sequence)
5. The coach's communication style (casual, formal, emoji usage, etc.)

OUTPUT FORMAT (JSON only):
{
  "coachName": "extracted or provided coach name",
  "coachingDetails": "brief description of what the coach does based on conversations",
  "styleNotes": "communication style observations - emoji usage, tone, message length, etc.",
  "sequences": {
    "lead": {
      "script": "Opening script in Q&A format between Prospect and Coach. Extract the natural flow of how coach engages new leads."
    },
    "qualification": {
      "script": "Qualification questions in Q&A format. Extract the questions coach asks to understand prospect needs."
    },
    "booking": {
      "script": "Booking pitch in Q&A format. How coach transitions to booking a call."
    },
    "callBooked": {
      "script": "Post-booking message. What coach says after someone books."
    }
  },
  "objectionHandlers": [
    {"objection": "common objection from chats", "response": "how coach handled it"}
  ]
}

SCRIPT FORMAT EXAMPLE:
"Prospect: [typical prospect message or question]
Coach: [coach's response]

Prospect: [next typical message]
Coach: [response]"

RULES:
1. Extract REAL patterns from the conversations, don't make things up
2. Keep the coach's natural voice and style
3. Use actual phrases and words the coach uses
4. If a sequence type isn't clearly present in chats, leave script empty
5. Extract 2-4 objection handlers if present in chats`,
};

async function seedSystemPrompts() {
    const mongoUri = process.env.MONGODB_URI;

    if (!mongoUri) {
        console.error("Error: MONGODB_URI environment variable is required");
        console.log("Usage: MONGODB_URI='your-mongo-uri' node scripts/seed-system-prompts.js");
        process.exit(1);
    }

    const client = new MongoClient(mongoUri);

    try {
        console.log("Connecting to MongoDB...");
        await client.connect();

        const db = client.db();
        const collection = db.collection(COLLECTION_NAME);

        console.log(`Upserting '${DOCUMENT_NAME}' document...`);

        const result = await collection.updateOne(
            { name: DOCUMENT_NAME },
            {
                $set: {
                    name: DOCUMENT_NAME,
                    prompts: SYSTEM_PROMPTS,
                    updatedAt: new Date(),
                },
                $setOnInsert: {
                    createdAt: new Date(),
                },
            },
            { upsert: true }
        );

        if (result.upsertedCount > 0) {
            console.log("✅ Created new system-prompts document");
        } else if (result.modifiedCount > 0) {
            console.log("✅ Updated existing system-prompts document");
        } else {
            console.log("ℹ️  No changes needed (document already up to date)");
        }

        // Verify the document
        const doc = await collection.findOne({ name: DOCUMENT_NAME });
        console.log("\nCurrent prompts in DB:");
        Object.keys(doc.prompts).forEach((key) => {
            console.log(`  - ${key}: ${doc.prompts[key].substring(0, 50)}...`);
        });

        console.log("\n✅ Done!");
    } catch (error) {
        console.error("Error seeding system prompts:", error.message);
        process.exit(1);
    } finally {
        await client.close();
    }
}

seedSystemPrompts();
