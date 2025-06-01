# Whisker App for Homey

This is an unofficial Homey integration for Whisker devices, focusing initially on the **Litter-Robot 4**. It brings your Whisker devices into your Homey based smart home with automations, insights, and more.

### 🙏 Special Thanks

This app builds on the work of [pylitterbot](https://github.com/natekspencer/pylitterbot) — huge thanks to [natekspencer](https://github.com/natekspencer) for reverse engineering the Whisker API and maintaining the Python integration!

## 🧠 Features

Bring automation and insights to your Litter-Robot 4 with Homey Flows and device capabilities:

### 📊 Device Capabilities

- `alarm_cat_detected` – Cat presence alarm
- `alarm_sleep_mode_active` – Sleep mode is currently active
- `alarm_sleep_mode_scheduled` – Sleep mode is scheduled
- `alarm_waste_drawer_full` – Waste drawer full indicator
- `clean_cycle_status` – Status of the cleaning cycle
- `clean_cycle_wait_time` – Set delay before cycle starts
- `key_pad_lock_out` – Lock/unlock the keypad
- `litter_robot_status` – Device status (ready, cycling, etc.)
- `measure_litter_level_percentage` – Litter level (%)
- `measure_odometer_clean_cycles` – Total clean cycles
- `measure_scoops_saved_count` – Estimated scoops saved
- `measure_waste_drawer_level_percentage` – Waste drawer fill level (%)
- `night_light_mode` – Off / On / Auto
- `panel_brightness` – Panel LED brightness
- `short_reset_press` – Trigger soft reset
- `sleep_mode_start_time` – When Sleep Mode activates
- `sleep_mode_end_time` – When Sleep Mode ends
- `start_clean_cycle` – Start cleaning
- `start_empty_cycle` – Start emptying

### 🔁 Flow Triggers (When...)

- Litter level above threshold
- Litter level below threshold
- Waste drawer level above threshold
- Waste drawer level below threshold
- Waste drawer becomes full
- Waste drawer is no longer full
- Cat detected
- Cat not detected
- Sleep mode activated
- Sleep mode deactivated
- Sleep mode starts in X hours
- Sleep mode ends in X hours
- Multiple clean cycles completed
- Problem details provided

### 📥 Flow Conditions (And...)

- Is a cat detected?
- Is sleep mode active?
- Is sleep mode scheduled?
- Is the waste drawer full?
- Is the robot currently cleaning?

### 🛠 Flow Actions (Then...)

- Start a clean cycle
- Start an empty cycle
- Lock or unlock the keypad
- Set night light mode (off/on/auto)
- Set panel brightness
- Set clean cycle wait time
- Press reset (short press)

## 📦 Supported Devices

- ✅ **Litter-Robot 4**
- 🟡 Litter-Robot 3 (integration planned — hardware sample needed)
- 🟡 Feeder-Robot (integration planned — hardware sample needed)

> Support for additional Whisker devices would be great — but we’ll need sample hardware to build and test those integrations.

**Cat data and individual pet stats** will be added in the future as a separate **“Cat” driver**.

## 🚀 Installation

You can try the app in two ways:

### ✅ Option 1: Install the test build via Homey App Store

👉 [Install the latest test version via Homey](https://homey.app/a/com.whisker/test/)

> Note: You’ll need a Homey Pro, support for Homey Cloud is planned.

---

### 🛠️ Option 2: Manual installation (for developers)

```bash
git clone https://github.com/yourusername/whisker-homey.git
cd whisker-homey
npm install
homey app install
