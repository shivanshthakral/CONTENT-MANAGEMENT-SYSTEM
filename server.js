import "dotenv/config";
import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenerativeAI } from "@google/generative-ai";
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

const app = express();
const PORT = 3000;

// Get the directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Enable CORS for frontend communication
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
}

// Configure multer for PDF upload
const upload = multer({ 
    dest: uploadsDir,
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf') {
            cb(null, true);
        } else {
            cb(new Error('Only PDF files are allowed!'), false);
        }
    },
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB limit
    }
});

// Initialize Google Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

// Function to read PDF content
async function readPDFContent(filePath) {
    try {
        const dataBuffer = fs.readFileSync(filePath);
        const options = {
            pagerender: function(pageData) {
                return pageData.getTextContent()
                    .then(function(textContent) {
                        let lastY, text = '';
                        for (let item of textContent.items) {
                            if (lastY == item.transform[5] || !lastY) {
                                text += item.str;
                            } else {
                                text += '\n' + item.str;
                            }
                            lastY = item.transform[5];
                        }
                        return text;
                    });
            }
        };
        
        const data = await pdfParse(dataBuffer, options);
        return data.text;
    } catch (error) {
        console.error('Error reading PDF:', error);
        throw new Error('Failed to read PDF file. Please ensure it is a valid PDF.');
    }
}

// Route to serve the landing page (default route)
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "landing.html"));
});

// Route to serve the content generator page
app.get("/generator", (req, res) => {
    res.sendFile(path.join(__dirname, "generator.html"));
});

// Route to serve the context page
app.get("/context", (req, res) => {
    res.sendFile(path.join(__dirname, "context.html"));
});

// Route to handle PDF upload and summary generation
app.post("/generate-summary", upload.single("pdf"), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: "No PDF uploaded" });
    }

    try {
        const pdfPath = req.file.path;
        const pdfContent = await readPDFContent(pdfPath);
        
        if (!pdfContent || pdfContent.trim().length === 0) {
            throw new Error('The PDF appears to be empty or could not be read properly.');
        }
        
        // Truncate content if it's too long (Gemini has a context limit)
        const truncatedContent = pdfContent.slice(0, 30000);
        
        // Get template from request
        const templateId = req.body.template || "1";
        
        // Load prompts from external file
        let prompts = {};
        try {
            const promptsData = JSON.parse(fs.readFileSync(path.join(__dirname, 'prompts.json'), 'utf8'));

            // Generate prompts dynamically from the configuration
            for (const [templateId, template] of Object.entries(promptsData.templates)) {
                prompts[templateId] = `Analyze the following document and generate content for a ${template.name} template. Format the response as a clean, well-structured JSON object.

${template.instructions.join('\n')}

Fields to generate:
${JSON.stringify(template.fields, null, 4)}

Analyze the provided document and generate appropriate content for each field.`;
            }
        } catch (error) {
            console.error('Error loading prompts:', error);
            return res.status(500).json({ error: 'Failed to load prompt templates' });
        }

        const prompt = prompts[templateId] + "\n\nDocument content to analyze:\n" + truncatedContent;
        
        const result = await model.generateContent(prompt);
        const summary = result.response.text();

        // Process the response to ensure proper JSON formatting
        const formattedSummary = summary
            .replace(/^```json\n|```$/g, '') // Remove any JSON code blocks
            .trim();

        try {
            // Validate and format the JSON
            const jsonObj = JSON.parse(formattedSummary);
            const prettyJson = JSON.stringify(jsonObj, null, 2);
            
            // Delete the uploaded PDF after processing
            fs.unlinkSync(pdfPath);

            res.json({ summary: prettyJson });
        } catch (error) {
            console.error('Error parsing JSON:', error);
            res.status(500).json({ error: 'Failed to format the generated content' });
        }
    } catch (error) {
        console.error("Error:", error);
        // Clean up the uploaded file if it exists
        if (req.file && req.file.path) {
            try {
                fs.unlinkSync(req.file.path);
            } catch (unlinkError) {
                console.error('Error deleting file:', unlinkError);
            }
        }
        res.status(500).json({ error: error.message || "Failed to generate summary" });
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: err.message || 'Something went wrong!' });
});

// Start the server
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📝 Open http://localhost:${PORT} in your browser to use the application`);
});
