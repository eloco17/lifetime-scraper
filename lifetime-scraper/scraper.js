// scraper.js
require('dotenv').config();
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const fs = require('fs');
const fetch = require('node-fetch');

async function scrapeLifetimeSchedule() {
  console.log("Starting scheduled Lifetime schedule scrape...");
  console.log(`Server time: ${new Date().toISOString()}`);

  let browser = null;
  
  try {
    // Get credentials from environment variables
    const username = process.env.LIFETIME_USERNAME;
    const password = process.env.LIFETIME_PASSWORD;
    const vercelApiUrl = process.env.VERCEL_API_URL;
    const vercelApiKey = process.env.VERCEL_API_KEY;

    if (!username || !password) {
      throw new Error("Missing Lifetime credentials in environment variables");
    }

    if (!vercelApiUrl) {
      throw new Error("Missing Vercel API URL in environment variables");
    }

    // Calculate the date for next Sunday (first day of next week)
    const today = new Date();
    const nextSunday = new Date(today);
    const daysUntilNextSunday = today.getDay() === 0 ? 7 : 7 - today.getDay();
    nextSunday.setDate(today.getDate() + daysUntilNextSunday);

    console.log(`Today is ${today.toDateString()}, next Sunday is ${nextSunday.toDateString()}`);

    // Create an array to store all days of the week
    const weekdays = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];

    // Initialize the schedule data
    const scheduleData = {
      month: nextSunday.toLocaleString("default", { month: "long" }).toUpperCase(),
      days: [],
      _source: "github-actions-scraper",
      _debug: {
        serverTime: today.toISOString(),
        calculatedNextSunday: nextSunday.toISOString(),
        daysUntilNextSunday,
      },
    };

    // Create a map to store sessions by day
    const dayMap = new Map();

    // Initialize the day map with all days of the week for next week
    for (let i = 0; i < 7; i++) {
      const sessionDate = new Date(nextSunday);
      sessionDate.setDate(nextSunday.getDate() + i);

      const dayName = weekdays[i];
      const date = sessionDate.getDate();
      const dayKey = `${dayName}-${date}`;

      dayMap.set(dayKey, {
        name: dayName,
        date: date,
        highlight: false,
        sessions: [],
        header: `${dayName} ${date}`,
      });
    }

    console.log("Launching browser...");

    // Optimized browser configuration for GitHub Actions
    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process",
        "--no-zygote",
        "--no-sandbox",
        "--disable-setuid-sandbox",
      ],
      defaultViewport: {
        width: 1024,
        height: 768,
        deviceScaleFactor: 1,
      },
      executablePath: await chromium.executablePath(),
      headless: true,
      ignoreHTTPSErrors: true,
    });

    console.log("Browser launched successfully");
    const page = await browser.newPage();

    // Set a realistic user agent
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
    );

    // Optimize page for memory usage
    await page.setCacheEnabled(false);
    
    // Block unnecessary resources to improve performance
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const resourceType = req.resourceType();
      if (resourceType === 'image' || resourceType === 'font' || resourceType === 'media') {
        req.abort();
      } else {
        req.continue();
      }
    });

    // Navigate to the login page
    console.log("Navigating to login page...");
    await page.goto("https://my.lifetime.life/login.html", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    console.log("Login page loaded");

    // Wait for and fill login form
    console.log("Looking for login form...");

    // Wait for username field
    await page.waitForSelector('input[type="email"], #username, input[name="username"]', { timeout: 10000 });

    // Fill username
    await page.type('input[type="email"], #username, input[name="username"]', username);
    console.log("Username filled");

    // Fill password
    await page.type('input[type="password"], #password', password);
    console.log("Password filled");

    // Click login button
    console.log("Clicking login button...");
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }),
      page.click('button[type="submit"], input[type="submit"]'),
    ]);
    console.log("Logged in successfully");

    // Format date for the URL - for next week
    const year = nextSunday.getFullYear();
    const month = String(nextSunday.getMonth() + 1).padStart(2, "0");
    const day = String(nextSunday.getDate()).padStart(2, "0");
    const formattedDate = `${year}-${month}-${day}`;

    // Go directly to the week view for next week
    const weekViewUrl = `https://my.lifetime.life/clubs/ny/penn-1/classes.html?teamMemberView=true&mode=week&selectedDate=${formattedDate}&interest=Pickleball+Open+Play&location=PENN+1`;
    console.log(`Navigating to week view: ${weekViewUrl}`);

    await page.goto(weekViewUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    console.log("Week view page loaded");

    // Wait for the schedule grid to load
    console.log("Waiting for schedule grid...");
    try {
      await page.waitForSelector(".planner-entry, .planner-row", { visible: true, timeout: 15000 });
      console.log("Schedule grid found");
    } catch (error) {
      console.error("Error waiting for schedule grid:", error.message);
      throw new Error("No schedule entries found");
    }

    // Wait a bit longer for all dynamic content to load
    await page.waitForTimeout(3000);

    // Extract all pickleball sessions from the week view
    console.log("Extracting schedule data for the week...");
    const weekScheduleData = await page.evaluate((weekdays, nextSundayDate) => {
      // Helper function to parse time string
      function parseTimeString(entry) {
        // First, try to find a time element with specific format
        const timeElements = Array.from(entry.querySelectorAll("*")).filter((el) => {
          const text = el.textContent || "";
          return text.match(/\d{1,2}:\d{2}/) && (text.includes("to") || text.includes("-"));
        });

        if (timeElements.length > 0) {
          const timeText = timeElements[0].textContent.trim();

          // Try different time formats
          // Format: "10:30 to 11:59 PM"
          let match = timeText.match(/(\d{1,2}):(\d{2})\s+to\s+(\d{1,2}):(\d{2})\s+(AM|PM)/i);
          if (match) {
            const [_, startHour, startMin, endHour, endMin, period] = match;
            return {
              startTime: `${startHour}:${startMin} ${period}`,
              endTime: `${endHour}:${endMin} ${period}`,
            };
          }

          // Format: "10:30 - 11:59 PM"
          match = timeText.match(/(\d{1,2}):(\d{2})\s+-\s+(\d{1,2}):(\d{2})\s+(AM|PM)/i);
          if (match) {
            const [_, startHour, startMin, endHour, endMin, period] = match;
            return {
              startTime: `${startHour}:${startMin} ${period}`,
              endTime: `${endHour}:${endMin} ${period}`,
            };
          }

          // Format: "10:30 AM to 11:59 AM"
          match = timeText.match(/(\d{1,2}):(\d{2})\s+(AM|PM)\s+to\s+(\d{1,2}):(\d{2})\s+(AM|PM)/i);
          if (match) {
            const [_, startHour, startMin, startPeriod, endHour, endMin, endPeriod] = match;
            return {
              startTime: `${startHour}:${startMin} ${startPeriod}`,
              endTime: `${endHour}:${endMin} ${endPeriod}`,
            };
          }

          // Format: "10:30 AM - 11:59 AM"
          match = timeText.match(/(\d{1,2}):(\d{2})\s+(AM|PM)\s+-\s+(\d{1,2}):(\d{2})\s+(AM|PM)/i);
          if (match) {
            const [_, startHour, startMin, startPeriod, endHour, endMin, endPeriod] = match;
            return {
              startTime: `${startHour}:${startMin} ${startPeriod}`,
              endTime: `${endHour}:${endMin} ${endPeriod}`,
            };
          }
        }

        // If we couldn't find a time element or parse the time, look for specific time elements
        const startTimeEl = entry.querySelector(".start-time, [class*='start-time'], [class*='startTime']");
        const endTimeEl = entry.querySelector(".end-time, [class*='end-time'], [class*='endTime']");

        if (startTimeEl && endTimeEl) {
          return {
            startTime: startTimeEl.textContent.trim(),
            endTime: endTimeEl.textContent.trim(),
          };
        }

        // Try to find time in the entry's text content
        const entryText = entry.textContent || "";
        const timeMatches = entryText.match(/(\d{1,2}):(\d{2})/g);
        if (timeMatches && timeMatches.length >= 2) {
          // Look for AM/PM
          const periodMatches = entryText.match(/(AM|PM)/gi);
          const periods = periodMatches ? periodMatches.map((p) => p.toUpperCase()) : ["AM", "AM"];

          return {
            startTime: `${timeMatches[0]} ${periods[0] || "AM"}`,
            endTime: `${timeMatches[1]} ${periods[1] || periods[0] || "AM"}`,
          };
        }

        // Default times
        return {
          startTime: "9:00 AM",
          endTime: "10:30 AM",
        };
      }

      // Helper function to extract skill level from title
      function extractSkillLevel(title) {
        const titleLower = title.toLowerCase();

        // Look for common skill level patterns
        if (titleLower.includes("all levels")) return "All Levels";
        if (titleLower.includes("beginner")) return "Beginner";
        if (titleLower.includes("intermediate")) return "Intermediate";
        if (titleLower.includes("advanced")) return "Advanced";

        // Look for numeric skill levels (e.g., 3.0+, 3.5-4.0)
        const skillMatch = titleLower.match(/(\d\.\d+[+-]?|\d\.\d+\s*-\s*\d\.\d+)/g);
        if (skillMatch) return skillMatch[0].toUpperCase();

        return null;
      }

      // Helper function to determine which day of the week an entry belongs to
      function getDayOfWeek(entry) {
        // Try to find the day based on column position
        const rect = entry.getBoundingClientRect();
        const container = document.querySelector(".planner-container, .week-view, .calendar-container");
        if (!container) return 0;
        
        const containerWidth = container.getBoundingClientRect().width;
        const columnWidth = containerWidth / 7;
        const dayIndex = Math.floor((rect.left - container.getBoundingClientRect().left) / columnWidth);
        
        return Math.min(Math.max(dayIndex, 0), 6); // Ensure it's between 0 and 6
      }

      // Helper function to get the date for a specific day index
      function getDateForDayIndex(dayIndex) {
        const date = new Date(nextSundayDate);
        date.setDate(date.getDate() + dayIndex);
        return date.getDate();
      }

      // Find ALL entries on the page
      const allEntries = Array.from(document.querySelectorAll(".planner-entry"));
      console.log(`Found ${allEntries.length} total entries on the page`);

      // Find all planner entries that might be pickleball sessions
      const pickleballEntries = allEntries.filter((entry) => {
        const text = entry.textContent || "";
        return text.toLowerCase().includes("pickleball");
      });
      console.log(`Found ${pickleballEntries.length} entries containing "pickleball" text`);

      // Array to store sessions by day
      const sessionsByDay = [[], [], [], [], [], [], []]; // One array for each day of the week

      // Process each pickleball entry
      pickleballEntries.forEach((entry, index) => {
        // Get the title
        let title = "Pickleball Open Play";
        const titleSelectors = [
          ".planner-entry-title a span",
          ".planner-entry-title span",
          ".planner-entry-title",
          ".title",
          "[class*='title']",
          "a span",
          "a",
        ];

        for (const selector of titleSelectors) {
          const titleEl = entry.querySelector(selector);
          if (titleEl) {
            const titleText = titleEl.textContent.trim();
            if (titleText && titleText.length > 0) {
              title = titleText;
              break;
            }
          }
        }

        // Get the time
        const { startTime, endTime } = parseTimeString(entry);

        // Get the location
        let location = "Indoor Pickleball Courts";
        const locationSelectors = [
          ".planner-col-md-3:nth-child(4)",
          ".location",
          "[class*='location']",
          ".venue",
          "[class*='venue']",
        ];

        for (const selector of locationSelectors) {
          const locationEl = entry.querySelector(selector);
          if (locationEl) {
            const locationText = locationEl.textContent.trim();
            if (locationText && locationText.length > 0) {
              location = locationText;
              break;
            }
          }
        }

        // Extract skill level
        const skillLevel = extractSkillLevel(title);

        // Extract status if available
        let status;
        const statusEl = entry.querySelector('.status, [class*="status"], .availability, [class*="availability"]');
        if (statusEl) {
          const statusText = statusEl.textContent.trim().toLowerCase();
          if (statusText.includes("waitlist")) {
            status = "Waitlist";
          } else if (statusText.includes("reserve") || statusText.includes("book")) {
            status = "Reserve";
          }
        }

        // Determine which day of the week this entry belongs to
        const dayIndex = getDayOfWeek(entry);
        const date = getDateForDayIndex(dayIndex);

        // Add the session to the appropriate day
        sessionsByDay[dayIndex].push({
          id: `${weekdays[dayIndex].toLowerCase()}-${date}-${index}`,
          startTime,
          endTime,
          title,
          subtitle: skillLevel ? `Skill Level: ${skillLevel}` : undefined,
          location,
          status,
        });
      });

      // Sort sessions by start time for each day
      sessionsByDay.forEach((sessions) => {
        sessions.sort((a, b) => {
          // Convert time strings to comparable values
          const getTimeValue = (timeStr) => {
            const [time, period] = timeStr.split(" ");
            let [hours, minutes] = time.split(":").map(Number);

            if (period === "PM" && hours < 12) hours += 12;
            if (period === "AM" && hours === 12) hours = 0;

            return hours * 60 + minutes;
          };

          return getTimeValue(a.startTime) - getTimeValue(b.startTime);
        });
      });

      return sessionsByDay;
    }, weekdays, nextSunday.toISOString());

    // Add the sessions to the day map
    weekScheduleData.forEach((daySessions, dayIndex) => {
      const sessionDate = new Date(nextSunday);
      sessionDate.setDate(nextSunday.getDate() + dayIndex);
      
      const dayName = weekdays[dayIndex];
      const date = sessionDate.getDate();
      const dayKey = `${dayName}-${date}`;

      const day = dayMap.get(dayKey);
      if (day) {
        day.sessions = daySessions;
        console.log(`Added ${daySessions.length} sessions to ${dayKey}`);
      }
    });

    // Convert the day map to an array
    const daysArray = Array.from(dayMap.values());

    // Sort days by date
    daysArray.sort((a, b) => {
      // First, try to sort by date
      if (a.date !== b.date) {
        return a.date - b.date;
      }

      // If dates are the same, sort by day of week
      const dayOrder = {
        SUNDAY: 0,
        MONDAY: 1,
        TUESDAY: 2,
        WEDNESDAY: 3,
        THURSDAY: 4,
        FRIDAY: 5,
        SATURDAY: 6,
      };

      return dayOrder[a.name] - dayOrder[b.name];
    });

    // Add the days to the schedule data
    scheduleData.days = daysArray;

    // Check if we have any days with no sessions
    const daysWithNoSessions = daysArray.filter((day) => day.sessions.length === 0);

    // If we have days with no sessions, try to create sessions based on a template day
    if (daysWithNoSessions.length > 0) {
      console.log(
        `Found ${daysWithNoSessions.length} days with no sessions, trying to create sessions based on a template day`
      );

      // Find a day with sessions to use as a template
      const templateDay = daysArray.find((day) => day.sessions.length > 0);

      if (templateDay) {
        console.log(`Using ${templateDay.name} as template with ${templateDay.sessions.length} sessions`);

        // Create sessions for days with no sessions
        daysWithNoSessions.forEach((day) => {
          console.log(`Creating sessions for ${day.name} based on template`);

          // Copy sessions from template day, adjusting IDs
          day.sessions = templateDay.sessions.map((session, index) => {
            const newSession = { ...session };
            newSession.id = `${day.name.toLowerCase()}-${day.date}-${index}`;

            // Adjust title if it contains the day name
            if (newSession.title.includes(templateDay.name)) {
              newSession.title = newSession.title.replace(templateDay.name, day.name);
            }

            // Add a subtle indicator that this is a copied session
            newSession.subtitle = session.subtitle
              ? `${session.subtitle} (Based on ${templateDay.name})`
              : `Based on ${templateDay.name}`;

            return newSession;
          });
        });
      }
    }

    console.log(
      `Extracted data for ${scheduleData.days.length} days with ${scheduleData.days.reduce(
        (sum, day) => sum + day.sessions.length,
        0
      )} total sessions`
    );

    // Save the data to a file
    const outputPath = './schedule-data.json';
    fs.writeFileSync(outputPath, JSON.stringify(scheduleData, null, 2));
    console.log(`Saved schedule data to ${outputPath}`);

    // Send the data to the Vercel API
    console.log(`Sending data to Vercel API: ${vercelApiUrl}`);
    
    const apiResponse = await fetch(vercelApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${vercelApiKey}`,
      },
      body: JSON.stringify({
        scheduleData,
        source: 'github-actions',
        timestamp: new Date().toISOString(),
      }),
    });

    if (!apiResponse.ok) {
      const errorText = await apiResponse.text();
      throw new Error(`Failed to send data to Vercel API: ${apiResponse.status} ${apiResponse.statusText} - ${errorText}`);
    }

    const apiResult = await apiResponse.json();
    console.log('Vercel API response:', apiResult);
    
    console.log('Scraping and data transfer completed successfully');
    return scheduleData;
  } catch (error) {
    console.error("Error in scrapeLifetimeSchedule:", error);
    throw error;
  } finally {
    if (browser) {
      await browser.close();
      console.log("Browser closed");
    }
  }
}

// Run the scraper
scrapeLifetimeSchedule()
  .then(() => {
    console.log('Scraper completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Scraper failed:', error);
    process.exit(1);
  });
