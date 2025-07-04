# Whisker App for Homey

This is an unofficial Homey integration for Whisker devices, focusing initially on the **Litter-Robot 4** and **Pet Information**. It brings your Whisker devices into your Homey based smart home with automations, insights, and comprehensive monitoring.

### 🙏 Special Thanks

This app builds on the work of [pylitterbot](https://github.com/natekspencer/pylitterbot) — huge thanks to [natekspencer](https://github.com/natekspencer) for reverse engineering the Whisker API and maintaining the Python integration!

## 🧠 Features

Bring automation and insights to your Whisker devices with Homey Flows and device capabilities:

### 📊 Litter-Robot 4 Capabilities

**Status & Monitoring:**
- `litter_robot_status` – Device status (ready, cycling, etc.)
- `clean_cycle_status` – Status of the cleaning cycle
- `alarm_connectivity` – Device connectivity status
- `last_seen` – When device was last online

**Cat Detection & Presence:**
- `alarm_cat_detected` – Cat presence alarm
- `measure_weight` – Cat weight measurement (for pet tracking)

**Waste Management:**
- `alarm_waste_drawer_full` – Waste drawer full indicator
- `measure_waste_drawer_level_percentage` – Waste drawer fill level (%)
- `measure_scoops_saved_count` – Estimated scoops saved

**Litter Management:**
- `measure_litter_level_percentage` – Litter level (%)
- `measure_odometer_clean_cycles` – Total clean cycles

**LitterHopper:**
- `alarm_litter_hopper_empty` – LitterHopper empty alarm
- `litter_hopper_enabled` – Enable/disable LitterHopper control
- `litter_hopper_status` – LitterHopper status monitoring

**Sleep Mode:**
- `alarm_sleep_mode_active` – Sleep mode is currently active
- `alarm_sleep_mode_scheduled` – Sleep mode is scheduled
- `sleep_mode_start_time` – When Sleep Mode activates
- `sleep_mode_end_time` – When Sleep Mode ends

**Controls & Settings:**
- `clean_cycle_wait_time` – Set delay before cycle starts
- `key_pad_lock_out` – Lock/unlock the keypad
- `night_light_mode` – Off / On / Auto
- `panel_brightness` – Panel LED brightness
- `start_clean_cycle` – Start cleaning
- `start_empty_cycle` – Start emptying
- `short_reset_press` – Trigger soft reset

### 🐱 Pet Information Capabilities

- `measure_weight` – Pet's current weight
- `label_gender` – Pet's gender
- `label_food` – Pet's diet information
- `label_environment` – Pet's environment type
- `label_birthday` – Pet's birthday
- `label_breed` – Pet's breed information
- `label_age` – Pet's age
- `alarm_health_concern` – Health concerns detected

### 🔁 Flow Triggers (When...)

**Litter-Robot 4:**
- Waste drawer becomes full
- Waste drawer is no longer full
- Cat detected
- Cat not detected
- Sleep mode activated
- Sleep mode deactivated
- Multiple clean cycles completed
- Problem details provided
- **LitterHopper becomes empty**
- **LitterHopper is no longer empty**

**Pet Information:**
- Health concern detected
- Age changed
- Environment changed
- Diet changed

### 📥 Flow Conditions (And...)

**Litter-Robot 4:**
- Is a cat detected?
- Is sleep mode active?
- Is sleep mode scheduled?
- Is the waste drawer full?
- Is the robot currently cleaning?
- **Is the LitterHopper empty?**
- **Is the LitterHopper enabled?**

**Pet Information:**
- Is it the pet's birthday today?
- Is it X days until the pet's birthday?

### 🛠 Flow Actions (Then...)

**Litter-Robot 4:**
- Start a clean cycle
- Start an empty cycle
- Lock or unlock the keypad
- Set night light mode (off/on/auto)
- Set panel brightness
- Set clean cycle wait time
- Press reset (short press)
- **Enable/disable LitterHopper**

## 📦 Supported Devices

- ✅ **Litter-Robot 4** - Full support with all capabilities including LitterHopper
- ✅ **Pet Information** - Complete pet monitoring and health tracking
- 🟡 Litter-Robot 3 (integration planned — hardware sample needed)
- 🟡 Feeder-Robot (integration planned — hardware sample needed)

> Support for additional Whisker devices would be great — but we'll need sample hardware to build and test those integrations.

## 🚀 Installation

You can try the app in two ways:

### ✅ Option 1: Install the test build via Homey App Store

👉 [Install the latest test version via Homey](https://homey.app/a/com.whisker/test/)

> Note: You'll need a Homey Pro, support for Homey Cloud is planned.

---

### 🛠️ Option 2: Manual installation (for developers)

```bash
git clone https://github.com/Doekse/whisker-homey.git
cd whisker-homey
npm install
homey app install
```
