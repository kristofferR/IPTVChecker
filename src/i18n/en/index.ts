import common from "./common";
import format from "./format";
import reasons from "./reasons";
import app from "./app";
import banners from "./banners";
import table from "./table";
import filters from "./filters";
import toolbar from "./toolbar";
import exportMenu from "./exportMenu";
import start from "./start";
import shortcuts from "./shortcuts";
import settings from "./settings";
import report from "./report";
import stats from "./stats";
import history from "./history";
import sources from "./sources";
import saved from "./saved";
import guide from "./guide";
import archive from "./archive";
import player from "./player";
import cast from "./cast";
import dispatcharr from "./dispatcharr";
import log from "./log";

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
} as const;
