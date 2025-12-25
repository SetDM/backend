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
