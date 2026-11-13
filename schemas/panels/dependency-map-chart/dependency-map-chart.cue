package model

import (
	"github.com/perses/shared/cue/common"
)

#frequency: "constantly" | "hourly" | "daily" | "weekly" | "monthly"
#share:     number & >=0 & <=1

kind: "DependencyMapChart"
spec: close({
	// Prometheus datasource: a selector or a variable. The default Prometheus datasource when unset.
	common.#datasourceSelector & {_kind: "PrometheusDatasource"}

	queries?: close({
		// OBI network flow query (bytes per hour per caller, callee and port). Empty turns it off.
		edge?: string
		// Fallback script query (depmap_connection_seen). Empty turns it off.
		fallback?: string
		// Optional bytes per hour per edge.
		volume?: string
	})
	// The mapping file, YAML or JSON: services, instances, owners, waves, HA groups, externals.
	mapping?: string
	// Observation window ending at the dashboard's end time, e.g. 30d. Up to 365d.
	window?: string & =~"^([0-9]+(ms|s|m|h|d|w|y))+$|^\\$"
	// Minimum share of the window's hours an edge is seen in, per class.
	frequencyThresholds?: close({
		constantly?: #share
		hourly?:     #share
		daily?:      #share
		weekly?:     #share
	})
	lanes?: close({
		// Label per wave number, e.g. {"1": "Wave 1 (March)"}.
		waveLabels?: {[=~"^[0-9]+$"]: string}
		stayLabel?:     string
		externalLabel?: string
		showExternal?:  bool
	})
	// Frequencies shown when the panel opens. All when unset.
	edgeFilter?: [...#frequency]
	linkTemplates?: close({
		node?: string
		edge?: string
	})
	// Preset failure scenarios: instance hosts (or IPs of unknown nodes) to take down.
	scenarios?: [...close({
		name: string & !=""
		down: [string, ...string]
	})]
	defaultMode?: "map" | "failure" | "needs"
})
