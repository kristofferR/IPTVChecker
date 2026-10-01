import app from "./app";
import archive from "./archive";
import banners from "./banners";
import cast from "./cast";
import common from "./common";
import dispatcharr from "./dispatcharr";
import exportMenu from "./exportMenu";
import filters from "./filters";
import format from "./format";
import guide from "./guide";
import history from "./history";
import languagePrompt from "./languagePrompt";
import log from "./log";
import player from "./player";
import reasons from "./reasons";
import report from "./report";
import saved from "./saved";
import settings from "./settings";
import shortcuts from "./shortcuts";
import sources from "./sources";
import start from "./start";
import stats from "./stats";
import table from "./table";
import toolbar from "./toolbar";

/** English source catalog. Every other locale is typed against it. */
export default {
  common,
  format,
  reasons,
  app,
  banners,
  table,
  filters,
  toolbar,
  exportMenu,
  start,
  shortcuts,
  settings,
  report,
  stats,
  history,
  sources,
  saved,
  guide,
  archive,
  player,
  cast,
  dispatcharr,
  log,
  languagePrompt,
} as const;
