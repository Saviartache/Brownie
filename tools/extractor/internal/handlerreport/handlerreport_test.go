package handlerreport

import "testing"

func TestCompareReportsFindsPacketBindingChanges(t *testing.T) {
	oldReport := Report{Build: "old", Functions: []Function{{Identity: "Manager.Handle(Message)", PacketIDs: []int{14}, Fingerprint: "same"}}}
	newReport := Report{Build: "new", Functions: []Function{{Identity: "Manager.Handle(Message)", PacketIDs: []int{28}, Fingerprint: "same"}}}
	diff := CompareReports(oldReport, newReport)
	if len(diff.BindingChanges) != 1 || diff.BindingChanges[0].OldIDs[0] != 14 || diff.BindingChanges[0].NewIDs[0] != 28 {
		t.Fatalf("binding changes = %#v", diff.BindingChanges)
	}
	if len(diff.Changed) != 0 {
		t.Fatalf("unchanged code was reported changed: %#v", diff.Changed)
	}
}

func TestSemanticTokensRecognizeSubsystemsAndAbbreviations(t *testing.T) {
	battlePass := semanticTokens("DecaGames.RotMG.Managers.BattlePassManager")
	if !battlePass["battlepass"] || !battlePass["bp"] {
		t.Fatalf("battle-pass tokens = %#v", battlePass)
	}
	milestone := semanticTokens("BoostBPMilestoneResultMessage")
	if !milestone["bp"] || !milestone["boost"] {
		t.Fatalf("milestone tokens = %#v", milestone)
	}
}

func TestCompareReportsFindsFactoryIDChangesByKind(t *testing.T) {
	oldReport := Report{MessageFactories: []MessageFactory{{Kind: "static byte registry", Bindings: []FactoryBinding{{ID: 14, ManagedType: "OLD"}}}}}
	newReport := Report{MessageFactories: []MessageFactory{{Kind: "static byte registry", Bindings: []FactoryBinding{{ID: 14, ManagedType: "RENAMED"}, {ID: 238, ManagedType: "NEW"}}}}}
	diff := CompareReports(oldReport, newReport)
	if len(diff.FactoryChanges) != 1 || len(diff.FactoryChanges[0].Added) != 1 || diff.FactoryChanges[0].Added[0].ID != 238 {
		t.Fatalf("factory changes = %#v", diff.FactoryChanges)
	}
	if len(diff.FactoryChanges[0].Removed) != 0 {
		t.Fatalf("obfuscated type rename was treated as an ID removal: %#v", diff.FactoryChanges[0])
	}
}
