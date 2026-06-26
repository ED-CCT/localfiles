const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const fs = require("fs");
const path = require("path");

const logsDir = path.join(
  process.env.USERPROFILE,
  "Saved Games",
  "Frontier Developments",
  "Elite Dangerous"
);

const scanInterval = 500;

// ======================================
// SERVER
// ======================================

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const clients = new Set();

// ======================================
// STATE
// ======================================

const colonisationClaims = [];
const shipcargo = new Map();
let  marketProducts = new Map();
const dockedEvents = [];
const depotEvents = [];

const fileOffsets = new Map();

// ======================================
// CONTROL FLAGS (NOWE)
// ======================================

let isInitialScan = true;
let batchCargoTransferCount = 0;
let lastevent;
// ======================================
// HELPERS
// ======================================

function normalizeType(type) {
  return (type || "").toLowerCase().replace(/\s+/g, ""); // usuwa wszystkie spacje
}

function addCargo(type, count) {
  type = normalizeType(type);

  if (!shipcargo.has(type)) {
    shipcargo.set(type, { Type: type, Count: 0 });
  }

  shipcargo.get(type).Count += count;
}

function removeCargo(type, count) {
  type = normalizeType(type);

  if (!shipcargo.has(type)) {
    shipcargo.set(type, { Type: type, Count: 0 });
  }

  shipcargo.get(type).Count -= count;

  if (shipcargo.get(type).Count <= 0) {
    shipcargo.delete(type);
  }
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// ======================================
// WEBSOCKET
// ======================================

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});
app.get("/table/", (req, res) => {
  res.sendFile(path.join(__dirname, "table.html"));
});

wss.on("connection", (ws) => {
  console.log("Browser connected");

  clients.add(ws);

  // 🔥 DODAJ TO:
  ws.on("message", (message) => {
    try {
      const packet = JSON.parse(message.toString());

      console.log("WS MESSAGE:", packet.type);

      // rozsyłaj do innych klientów
      broadcast(packet);

    } catch (err) {
      console.error("WS message error:", err);
    }
  });
  notifyFrontend(lastevent, "Market", false);
  ws.on("close", () => {
    clients.delete(ws);
  });
});

function broadcast(data) {
  const payload = JSON.stringify(data);

  for (const client of clients) {
    if (client.readyState === 1) {
      client.send(payload);
    }
  }
}

// ======================================
// NOTIFY FRONTEND (POPRAWIONE)
// ======================================

function notifyFrontend(event, eventName, batchMode = false) {
  const result = buildResult();

  broadcast({
    type: "LIVE_DATA",
    data: result,
    event: eventName,
  });

  broadcast({
    type: "EVENT",
    event: eventName,
	data2: event,
    batch: batchMode,
    timestamp: Date.now(),
  });

  console.log("Frontend notified:", eventName, batchMode ? "(BATCH)" : "(LIVE)");
}

// ======================================
// EVENT PROCESSOR
// ======================================

function processEvent(event) {
  // CLAIM
  if (event.event === "ColonisationSystemClaim") {
    colonisationClaims.push({
      timestamp: event.timestamp,
      StarSystem: event.StarSystem,
      SystemAddress: event.SystemAddress,
    });
    return;
  }

  // DOCKED
  if (
    event.event === "Docked" &&
    event.SystemAddress &&
    typeof event.StationName === "string" &&
    (event.StationName.startsWith("$EXT_PANEL_ColonisationShip;") || event.StationName.startsWith("Orbital Construction Site") || event.StationName.startsWith("Planetary Construction Site"))
  ) {
    dockedEvents.push(event);
    return;
  }
  // DEPOT
  if (event.event === "ColonisationConstructionDepot") {
    depotEvents.push(event);
    if (isInitialScan) {
      batchCargoTransferCount++;
      return;
    }
	notifyFrontend(event, "ColonisationConstructionDepot", false);
    return;
  }

  // CARGO BUY
  if (event.event === "MarketBuy") {
    addCargo(event.Type, event.Count);
    if (isInitialScan) {
      batchCargoTransferCount++;
      return;
    }
	notifyFrontend(event, "MarketBuy", false);
    return;
  }  
  if (event.event === "Market") {
    marketProducts = getProducedItems();
    if (isInitialScan) {
      batchCargoTransferCount++;
      return;
    }
	lastevent = event;
	notifyFrontend(event, "Market", false);
    return;
  } 
  if (event.event === "MarketSell") {
    removeCargo(event.Type, event.Count);
    if (isInitialScan) {
      batchCargoTransferCount++;
      return;
    }
	notifyFrontend(event, "MarketSell", false);
    return;
  }  
  
	if (event.event === "ColonisationContribution" && Array.isArray(event.Contributions)) {
		for (const transfer of event.Contributions) {
			removeCargo(transfer.Name_Localised, transfer.Amount);
		}
		if (isInitialScan) {
		  batchCargoTransferCount++;
		  return;
		}
		notifyFrontend(event, "ColonisationContribution", false);
		return;
	}
  
  if (event.event === "CollectCargo") {
	const countCollect = 1;
    addCargo(event.Type, countCollect);
    if (isInitialScan) {
      batchCargoTransferCount++;
      return;
    }
	notifyFrontend(event, "CollectCargo", false);
    return;
  }

  if (event.event === "EjectCargo") {
    removeCargo(event.Type, event.Count);
    if (isInitialScan) {
      batchCargoTransferCount++;
      return;
    }
	notifyFrontend(event, "EjectCargo", false);
    return;
  }
  
  if (event.event === "MiningRefined") {
	const countRefined = 1;
    addCargo(event.Type, countRefined);
    if (isInitialScan) {
      batchCargoTransferCount++;
      return;
    }
	notifyFrontend(event, "MiningRefined", false);
    return;
  }
  
  // CARGO RESET
  if (event.event === "Cargo" && event.Vessel === "Ship" && event.Count === 0) {
    shipcargo.clear();
    if (isInitialScan) {
      batchCargoTransferCount++;
      return;
    }
	notifyFrontend(event, "Cargo", false);
    return;
  }

  // ======================================
  // 🚨 CARGO TRANSFER (FIXED LOGIC)
  // ======================================

  if (
    event.event === "CargoTransfer" &&
    Array.isArray(event.Transfers)
  ) {
    for (const transfer of event.Transfers) {
      if (transfer.Direction === "tocarrier") {
        removeCargo(transfer.Type, transfer.Count);
      }
	  if (transfer.Direction === "toship") {
        addCargo(transfer.Type, transfer.Count);
      }
    }

    // 🔥 BATCH MODE (STARTUP / RESYNC)
    if (isInitialScan) {
      batchCargoTransferCount++;
      return;
    }
	notifyFrontend(event, "CargoTransfer", true);
    return;
  }
}

// ======================================
// BUILD RESULT (bez zmian logicznych)
// ======================================
let unmatchedClaims = [];
let unmatchedDocked = [];
function buildResult() {

	const allClaims = [
		...unmatchedClaims,
		...colonisationClaims,
	];

	const allDockedEvents = [
		...unmatchedDocked,
		...dockedEvents,
	];

	// ======================================
	// 1. filtr zakończonych MarketID
	// ======================================

	const completedMarketIDs = new Set();
	const checkedMarketIDs = new Set();

	for (let i = depotEvents.length - 1; i >= 0; i--) {
		const depot = depotEvents[i];

		if (checkedMarketIDs.has(depot.MarketID)) continue;

		checkedMarketIDs.add(depot.MarketID);

		if (depot.ConstructionComplete === true) {
			completedMarketIDs.add(depot.MarketID);
		}
	}

	const filteredDockedEvents = allDockedEvents.filter(
		d => !completedMarketIDs.has(d.MarketID)
	);

	const filteredDepotEvents = depotEvents.filter(
		d => !completedMarketIDs.has(d.MarketID)
	);

	// ======================================
	// 2. NAJNOWSZY Docked dla MarketID
	// ======================================

	const latestDockedByMarket = new Map();

	for (const docked of filteredDockedEvents) {

		const id = docked.MarketID;

		const prev = latestDockedByMarket.get(id);

		if (!prev || new Date(docked.timestamp) > new Date(prev.timestamp)) {
			latestDockedByMarket.set(id, docked);
		}
	}

	// ======================================
	// 3. Depot Map (ostatni wpis per MarketID)
	// ======================================

	const depotMap = new Map();

	for (let i = filteredDepotEvents.length - 1; i >= 0; i--) {
		const depot = filteredDepotEvents[i];

		if (!depotMap.has(depot.MarketID)) {
			depotMap.set(depot.MarketID, depot);
		}
	}

	// ======================================
	// 4. Grupowanie po systemie
	// ======================================

	const systemMap = new Map();

	for (const claim of allClaims) {

		const system = claim.SystemAddress;

		if (!systemMap.has(system)) {
			systemMap.set(system, {
				StarSystem: claim.StarSystem,
				DockedStations: []
			});
		}

		const entry = systemMap.get(system);

		// tylko najnowsze docked
		for (const docked of latestDockedByMarket.values()) {

			if (docked.SystemAddress !== system) continue;

			const depot = depotMap.get(docked.MarketID);

			entry.DockedStations.push({
				timestamp: docked.timestamp,
				MarketID: docked.MarketID,
				StationName: docked.StationName,
				ResourcesRequired: (depot?.ResourcesRequired || []).map(r => ({
					Name_Localised: r.Name_Localised,
					RequiredAmount: r.RequiredAmount,
					ProvidedAmount: r.ProvidedAmount,
				}))
			});
		}
	}

	// ======================================
	// 5. RESULT
	// ======================================

	const resultClaims = Array.from(systemMap.values()).filter(system => system.DockedStations.length > 0);

	return {
		colonisationClaims: resultClaims,
		shipcargo: Array.from(shipcargo.values()),
		Market: Array.from(marketProducts.values()),
	};
}

// ======================================
// SAVE + SYNC (KLUCZOWE)
// ======================================

function saveResult(event) {
  const result = buildResult();

  fs.writeFileSync(
    path.join(logsDir, "parsed-output.json"),
    JSON.stringify(result, null, 2),
    "utf8"
  );


  // ======================================
  // 🔥 FIRST SYNC COMPLETE → ONE IMPULSE
  // ======================================

  if (isInitialScan) {
    console.log("INITIAL SYNC COMPLETE");

    if (batchCargoTransferCount > 0) {
      notifyFrontend(event, "CargoTransferBatch", true);
    }
	
    isInitialScan = false;
  }
}

// ======================================
// SCAN LOGS
// ======================================

async function scanLogs() {
  let eventlocal = {"event":"None"};
  const files = fs
    .readdirSync(logsDir)
    .filter(file =>
      /^Journal\.\d{4}-\d{2}-\d{2}T\d{6}\.\d+\.log$/.test(file)
    )
    .sort((a, b) => a.localeCompare(b));

  for (const file of files) {
    const fullPath = path.join(logsDir, file);

    const stats = fs.statSync(fullPath);
    const lastOffset = fileOffsets.get(file) || 0;

    if (stats.size <= lastOffset) continue;

    const stream = fs.createReadStream(fullPath, {
      encoding: "utf8",
      start: lastOffset,
      end: stats.size,
    });

    let content = "";

    for await (const chunk of stream) {
      content += chunk;
    }

    fileOffsets.set(file, stats.size);

    const lines = content.split(/\r?\n/);

    for (const line of lines) {
      if (!line.trim()) continue;

      const event = parseJsonLine(line);
      if (!event) continue;
	  eventlocal = event;
      processEvent(event);
    }
  }

  saveResult(eventlocal);
}

function getProducedItems() {
  const marketFile = path.join(logsDir, "Market.json");

  if (!fs.existsSync(marketFile)) {
    throw new Error(`Nie znaleziono pliku: ${marketFile}`);
  }

  const market = JSON.parse(fs.readFileSync(marketFile, "utf8"));

  const result = [];

  for (const item of market.Items || []) {
    if (!item.Producer) continue;

    const type = normalizeType(item.Name_Localised);
    result.push({
      Type: type,
      Stock: item.Stock
    });
  }

  return result;
}
// ======================================
// MAIN
// ======================================

async function main() {
  console.log("STARTING LIVE MONITOR...\n");

  await scanLogs();

  setInterval(async () => {
    try {
      await scanLogs();
    } catch (err) {
      console.error(err);
    }
  }, scanInterval);
}

main();

server.listen(80, "0.0.0.0", () => {
  console.log("APP RUNNING");
});