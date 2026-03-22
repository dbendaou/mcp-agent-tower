#!/usr/bin/env node

import { startDaemon } from "./server.js";

const port = Number(process.argv[2]) || undefined;
startDaemon(port);
