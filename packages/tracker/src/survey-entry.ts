// Entry of survey.js: mm.js loads this only when a live survey is due for this visitor and page.
import { runSurveys } from "./survey-widget";

window.mmSurveyUI = runSurveys;
