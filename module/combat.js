
export class DX3rdCombat extends Combat {
  
  /** @inheritdoc */
  async _onCreate(data, options, userId) {
    super._onCreate(data, options, userId);
    if (game.user.id != userId)
      return;
      
    let startActor = null, startLabel = "[ Setup ]";
    let endActor = null, endLabel = "[ Cleanup ]"
    
    let startToken = null
    let endToken = null
    
    for (let a of game.actors) {
      if (a.name == startLabel)
        startActor = a;
      else if (a.name == endLabel)
        endActor = a;
    }
  
    if (startActor == null)
      startActor = await Actor.create({name: startLabel, type: "character", img: "icons/pings/chevron.webp"});
    if (endActor == null)
      endActor = await Actor.create({name: endLabel, type: "character", img: "icons/pings/chevron.webp"});


    for (let a of this.scene.tokens) {
      if (a.name == startLabel)
        startToken = a;
      else if (a.name == endLabel)
        endToken = a;
    }
    
    if (startToken == null)
      startToken = (await this.scene.createEmbeddedDocuments("Token", [{alpha: 0, actorId: startActor.id}], {}))[0];
    if (endToken == null)
      endToken = (await this.scene.createEmbeddedDocuments("Token", [{alpha: 0, actorId: endActor.id}], {}))[0];


    await this.setFlag("dx3rd", "startToken", startToken.uuid);
    await this.setFlag("dx3rd", "endToken", endToken.uuid);

    await this.createEmbeddedDocuments("Combatant", [{actorId: startActor.id, tokenId: startToken.id, name: startLabel, img: startActor.img, initiative: 9999}, {actorId: endActor.id, tokenId: endToken.id, name: endLabel, img: startActor.img, initiative: -9999}], {});
    
    if ( !this.collection.viewed ) ui.combat.initialize({combat: this});
  }
    
  /** @Override */
  async rollInitiative(ids, {formula=null, updateTurn=true, messageOptions={}}={}) {
    let startTokenUUID = this.flags["dx3rd"].startToken;
    let endTokenUUID = this.flags["dx3rd"].endToken;

    let startToken = await fromUuid(startTokenUUID);
    let endToken = await fromUuid(endTokenUUID);


    // Structure input data
    ids = typeof ids === "string" ? [ids] : ids;
    const currentId = this.combatant?.id;
    const rollMode = messageOptions.rollMode || game.settings.get("core", "rollMode");

    // Iterate over Combatants, performing an initiative roll for each
    const updates = [];
    const messages = [];
    for ( let [i, id] of ids.entries() ) {

      // Get Combatant data (non-strictly)
      const combatant = this.combatants.get(id);
      if ( !combatant?.isOwner ) return results;

      // Produce an initiative roll for the Combatant
      const roll = combatant.getInitiativeRoll(formula);
      await roll.evaluate({async: true});

      let init = roll.total;
      if (combatant.tokenId == startToken.id)
        init = 9999
      else if (combatant.tokenId == endToken.id)
        init = -9999

      updates.push({_id: id, initiative: init});
    }
    if ( !updates.length ) return this;

    // Update multiple combatants
    await this.updateEmbeddedDocuments("Combatant", updates);

    // Ensure the turn order remains with the same combatant
    if ( updateTurn && currentId ) {
      await this.update({turn: this.turns.findIndex(t => t.id === currentId)});
    }

    // Create multiple chat messages
    await ChatMessage.implementation.create(messages);
    return this;
  }

  _sortCombatants(a, b) {
    const ia = Number.isNumeric(a.initiative) ? a.initiative : -9999;
    const ib = Number.isNumeric(b.initiative) ? b.initiative : -9999;
    let ci = ib - ia;
    if ( ci !== 0 ) return ci;

    if (a.isNPC !== b.isNPC) {
      if (a.isNPC)
        return 1;
      else
        return -1;
    }

    let cn = a.name.localeCompare(b.name);   
    if ( cn !== 0 ) return cn;
    return a.id - b.id;
  }

  /* -------------------------------------------- */	
  
   /** @Override */
  async _onDelete(options, userId) {
    let startTokenUUID = this.flags["dx3rd"].startToken;
    let endTokenUUID = this.flags["dx3rd"].endToken;

    super._onDelete(options, userId);
    
    if (game.user.isGM) {
      let startToken = await fromUuid(startTokenUUID);
      let endToken = await fromUuid(endTokenUUID);

      await startToken.delete();
      await endToken.delete();
    }
  }

  /* -------------------------------------------- */	

  // 이니셔티브 재굴림
  async _rollInitiative() {
    for (let combatant of this.combatants) {
      if (combatant.name === "[ Setup ]") {
        await combatant.update({ initiative: 9999 });
      }
      else if (combatant.name === "[ Cleanup ]") {
        await combatant.update({ initiative: -9999 });
      } else {
        // 각 컴배턴트의 이니셔티브 재굴림
        await combatant.rollInitiative();
      }
    }

    // 전투 데이터 업데이트
    await this.update({ round: this.round });
  }

  async startCombat() {
    // 먼저 모든 컴배턴트의 이니셔티브를 굴림
    await this._rollInitiative();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 이후 전투 시작을 진행
    super.startCombat();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await this.countRounds()
  }

  async nextTurn() {
    const combatant = this.turns[this.turn];

    if (combatant.name === "[ Setup ]" || combatant.name === "[ Cleanup ]") {
      // [setup] 또는 [cleanup]일 경우 바로 다음 턴으로 이동
      super.nextTurn();
      if (combatant.name === "[ Setup ]") {
        await new Promise((resolve) => setTimeout(resolve, 50));
        this.initiative()
      }
    } else if (combatant.actor.system.conditions.action_delay?.active || combatant.actor.system.conditions.action_end?.active) {
      await this._rollInitiative(); // 이니셔티브 재굴림
      await new Promise((resolve) => setTimeout(resolve, 50));
      this._turnOrder(); // 다음 턴으로 이동
    } else {
      // 다이얼로그 생성
      new Dialog({
        title: "Turn End",
        content: `
        <p>${combatant.name}</p>
      `,
        buttons: {
          endAction: {
            label: game.i18n.localize("DX3rd.ActionEnd"),
            callback: async () => {
              // 행동 종료 상태 업데이트
              await combatant.actor.update({
                "system.conditions.action_end.active": true
              });
              await this._rollInitiative(); // 이니셔티브 재굴림
              await new Promise((resolve) => setTimeout(resolve, 50));
              this._turnOrder(); // 다음 턴으로 이동
            },
          },
          delayAction: {
            label: game.i18n.localize("DX3rd.ActionDelay"),
            callback: async () => {
              // 행동 대기 상태 업데이트
              await combatant.actor.update({
                "system.conditions.action_delay.active": true
              });
              await this._rollInitiative(); // 이니셔티브 재굴림
              await new Promise((resolve) => setTimeout(resolve, 50));
              this._turnOrder(); // 다음 턴으로 이동
            },
          }
        },
        default: "endAction"
      }).render(true);
    }
  }

  // 다음 턴으로 이동
  async _turnOrder() {
    let sortedTurns = this.turns.filter(turn => {
      let actor = turn.actor;
      if (!actor || !actor.system || !actor.system.conditions) {
        return false;
      }

      let defeated = actor.system.conditions.defeated?.active;
      let end = actor.system.conditions.action_end?.active;
      let alive = actor.system.attributes.hp.value > 0;

      return !defeated && !end && alive;  // 행동 종료되지 않고, 생존한 캐릭터만 필터링
    });

    // sortedTurns가 비어 있을 경우, 기본 턴 이동 처리
    if (sortedTurns.length === 0) {
      super.nextTurn();
      await new Promise((resolve) => setTimeout(resolve, 100));
      this.initiative()
    }

    // 가장 빠른 이니셔티브를 가진 캐릭터 찾기
    let targetInitiative = sortedTurns[0]?.initiative;

    if (targetInitiative !== undefined) {
      // 가장 높은 이니셔티브를 가진 캐릭터들
      let highestInitiativeTurns = sortedTurns.filter(
        (turn) => turn.initiative === targetInitiative
      );

      // 현재 턴이 아닌 캐릭터 선택 (this.combatant 대신 this.turn 사용)
      let targetTurn = highestInitiativeTurns.find(
        (turn) => turn.id !== this.turn.id
      );

      if (!targetTurn) {
        // 만약 선택된 캐릭터가 없을 경우 가장 첫번째 캐릭터 선택
        targetTurn = highestInitiativeTurns[0];
      }

      // 선택된 캐릭터의 턴으로 이동
      let targetIndex = this.turns.findIndex((turn) => turn.id === targetTurn.id);
      await this.update({ turn: targetIndex, turnOrder: this.turns });

      console.log(`${game.i18n.localize("DX3rd.InitiativeCharacter")}: ${targetTurn.actor.name}`);

      this.initiative()
    }
  }

  async initiative() {
    let initCharacter = this.combatant.name === "[ Cleanup ]" ? game.i18n.localize("DX3rd.Null") : this.combatant.name;

    let content = `
    <div class="dx3rd-roll">
      <h2 class="header"><div class="title width-100">
        ${game.i18n.localize("DX3rd.Initiative")} ${game.i18n.localize("DX3rd.Process")}
      </div></h2><hr>
      <div class="context-box">
        ${game.i18n.localize("DX3rd.InitiativeCharacter")}: ${initCharacter}
      </div>
    </div>
  `

    ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ alias: "GM" }),
      content: content,
      type: CONST.CHAT_MESSAGE_TYPES.IC,
    });

    setTimeout(() => {
      if (this.combatant.name === "[ Cleanup ]") {
        this.startCleanupDialog();  // 클린업 프로세스 실행
      } else if (this.combatant.name === "[ Setup ]") {
        ui.notificationsinfo(`setup process`)
      } else {
        this.startMainDialog();  // 메일 프로세스 실행
      }
    }, 3000); // 3초 정도의 텀을 두고 다이얼로그 호출
  }

  async startMainDialog() {
    let content = `
    <div>${game.i18n.localize("DX3rd.InitiativeCharacter")}: ${this.combatant.name}</div><hr>
    <div style="display: flex; flex-direction: column;">
      <button class="macro-button" data-action="1">${game.i18n.localize("DX3rd.MainStart")}</button>
      <button class="macro-button" data-action="2">${game.i18n.localize("DX3rd.ReCheck")}</button>
    </div>
  `;
    let startMainDialog = new Dialog({
      title: `${game.i18n.localize("DX3rd.Main")} ${game.i18n.localize("DX3rd.Process")}`,
      content: content,
      buttons: {},
      close: () => { },
      render: html => {
        html.find(".macro-button").click(ev => {
          let action = parseInt(ev.currentTarget.dataset.action);
          switch (action) {
            case 1:
              let message = `
              <div class="dx3rd-roll">
                <h2 class="header"><div class="title width-100">
                  ${game.i18n.localize("DX3rd.Main")} ${game.i18n.localize("DX3rd.Process")}
                </div></h2><hr>
                <div class="context-box">
                  ${game.i18n.localize("DX3rd.InitiativeCharacter")}: ${this.combatant.name}
                </div>
              </div>
            `
              ChatMessage.create({
                speaker: ChatMessage.getSpeaker({ alias: "GM" }),
                content: message,
                type: CONST.CHAT_MESSAGE_TYPES.IC,
              });
              break;
            case 2:
              this._rollInitiative(); // 이니셔티브 재굴림
              new Promise((resolve) => setTimeout(resolve, 50));
              this._turnOrder(); // 다음 턴으로 이동
              break;
            default:
              break;
          }
          startMainDialog.close();
        });
      }
    });
    startMainDialog.render(true);
  }

  async startCleanupDialog() {
    let content = `
    <div style="display: flex; flex-direction: column;">
      <button class="macro-button" data-action="1">${game.i18n.localize("DX3rd.CleanupStart")}</button>
      <button class="macro-button" data-action="2">${game.i18n.localize("DX3rd.ReCheck")}</button>
    </div>
  `;
    let startCleanupDialog = new Dialog({
      title: `${game.i18n.localize("DX3rd.Cleanup")} ${game.i18n.localize("DX3rd.Process")}`,
      content: content,
      buttons: {},
      close: () => { },
      render: html => {
        html.find(".macro-button").click(ev => {
          let action = parseInt(ev.currentTarget.dataset.action);
          switch (action) {
            case 1:
              let message = `
              <div class="dx3rd-roll">
                <h2 class="header"><div class="title width-100">
                  ${game.i18n.localize("DX3rd.Cleanup")} ${game.i18n.localize("DX3rd.Process")}
                </div></h2><hr>
              </div>
            `
              ChatMessage.create({
                speaker: ChatMessage.getSpeaker({ alias: "GM" }),
                content: message,
                type: CONST.CHAT_MESSAGE_TYPES.IC,
              });
              break;
            case 2:
              this._rollInitiative(); // 이니셔티브 재굴림
              new Promise((resolve) => setTimeout(resolve, 50));
              this._turnOrder(); // 다음 턴으로 이동
              break;
            default:
              break;
          }
          startCleanupDialog.close();
        });
      }
    });
    startCleanupDialog.render(true);
  }

  async previousTurn() {
    super.previousTurn();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await this._rollInitiative(); // 이니셔티브 재굴림
    await new Promise((resolve) => setTimeout(resolve, 50));
    this._turnOrder(); // 다음 턴으로 이동
  }

  async countRounds() {
    let currentRound = this.round;  // 현재 라운드를 가져옴

    let startContent = ``;
    if (currentRound === 1) {
      startContent = `
      <h2 class="header"><div class="title width-100">
        ${game.i18n.localize("DX3rd.CombatStart")}
      </div></h2><hr>
    `;
    }

    let content = `
    <div class="dx3rd-roll">
      ${startContent}
      <h2 class="header"><div class="title width-100">
        ${game.i18n.localize("DX3rd.Round")} ${currentRound}
      </div></h2><hr>
      <h2 class="header"><div class="title width-100">
        ${game.i18n.localize("DX3rd.Setup")} ${game.i18n.localize("DX3rd.Process")}
      </div></h2><hr>
    </div>
  `

    ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ alias: "GM" }),  // 여기서 GM으로 설정
      content: content,
      type: CONST.CHAT_MESSAGE_TYPES.IC,
    });
  }

  //라운드 종료 시 기능//
  async nextRound() {
    // 모든 컴배턴트의 액션 종료와 대기 상태를 초기화
    for (let combatant of this.combatants) {
      await combatant.actor.update({
        "system.conditions.action_end.active": false,
        "system.conditions.action_delay.active": false
      });
    }

    // 기본 라운드 이동 처리 호출
    super.nextRound();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await this.countRounds()
  }

  //전투 종료 시 기능//
  async endCombat() {
    // 모든 컴배턴트를 반복하면서 행동 종료와 대기 상태를 초기화
    for (let combatant of this.combatants) {
      await combatant.actor.update({
        "system.conditions.action_end.active": false,
        "system.conditions.action_delay.active": false
      });
    }

    let content = `
    <div class="dx3rd-roll">
      <h2 class="header"><div class="title width-100">
        ${game.i18n.localize("DX3rd.CombatEnd")}
      </div></h2><hr>
    </div>
  `

    ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ alias: "GM" }),  // 여기서 GM으로 설정
      content: content,
      type: CONST.CHAT_MESSAGE_TYPES.IC,
    });

    // 기본 전투 종료 처리 호출
    super.endCombat();
  }

}
