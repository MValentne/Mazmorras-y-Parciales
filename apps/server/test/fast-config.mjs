/** Relojes breves sólo para el proceso de pruebas; producción conserva sus tiempos. */
import { GAME_CONFIG } from "@dungeon/shared";
GAME_CONFIG.promptPreviewSeconds = 0.15;
GAME_CONFIG.questionTimeSeconds = 0.6;
GAME_CONFIG.answerRevealMs = 100;
GAME_CONFIG.feedbackCorrectDelayMs = 30;
