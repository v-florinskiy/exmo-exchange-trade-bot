const exmo = require("./exmo");

const apiKey = 'YOUR-API-KEY';
const apiSecret = 'YOUR-API-SECRET';

const currency1 = 'BTC';
const currency2 = 'USD';
const currency1MinQuantity = 0.001; //минимальная сумма ставки - берется из https://api.exmo.com/v1/pair_settings/
const orderLifeTime = 3; //через сколько минут отменять неисполненный ордер на покупку currency1
const stockFee = 0.002; //Комиссия, которую берет биржа (0.002 = 0.2%)
const avgPricePeriod = 20; //За какой период брать среднюю цену (мин)
const canSpend = 7; //Сколько тратить currency2 каждый раз при покупке currency1
const profit = 0.003; //Какой навар нужен с каждой сделки? (0.001 = 0.1%)
const stockTimeOffset = 0; //Если расходится время биржи с текущим в часах

let currentPair = currency1+'_'+currency2;

exmo.init_exmo({key:apiKey, secret:apiSecret});

//реализуем алгоритм
function trade(){
  //получаем список открытых ордеров
  let openedOrders = exmo.api_query("user_open_orders", { }, result=>{

    let res = JSON.parse(result);
    //console.log(res[currentPair]);
    if(res[currentPair] == undefined) console.log('Открытых оредеров нет');

    //res = res[currentPair][0];

    let buyOrders = [];
    
    //Есть ли неисполненные ордера на продажу currency1
    for(let i in res[currentPair]){
      console.log(res[currentPair][i]);
      if(res[currentPair][i].type == 'sell'){
          console.log('Выход, ждем пока не исполнятся/закроются все ордера на продажу');
      }else{
        //запоминаем ордера на покупку
        buyOrders.push(res[currentPair][i]);
      }
    }

    
    if(buyOrders.length > 0){ //Проверяем, есть ли открытые ордера на покупку currency1
        for(let key in buyOrders){
          console.log('Проверяем, что происходит с отложенным ордером', buyOrders[key]['order_id']);
          
          exmo.api_query('order_trades', {"order_id": buyOrders[key]['order_id']}, result => {
          	let res = JSON.parse(result);
          	
          	if(res.result !== false){
          		//по ордеру уже есть частичное выполнение, выход
				console.log('Выход, продолжаем надеяться докупить валюту по тому курсу, по которому уже купили часть');
          	}else{
          		let timePassed = (new Date().getTime() / 1000) + stockTimeOffset * 60 * 60 - (buyOrders[key]['created']);

	            if(timePassed > orderLifeTime * 60){
	              //ордере слишком долго висит, отменяем
	              //console.log(buyOrders[key]['order_id'])
	              exmo.api_query('order_cancel',{"order_id":buyOrders[key]['order_id']}, res => {
	              		let result = JSON.parse(res);
	                  	if(result.error) console.log(result.error);

	                   	console.log(`Отменяем ордер за ${orderLifeTime} минут не удалось купить ${currency1}`);
	                });
	              
	            }else{
	              console.log(`Выход, продолжаем надеяться купить валюту по указанному ранее курсу, со времени создания ордера прошло ${timePassed} секунд`);
	            }
          	}
          });
          
        }
    }else{ //Открытых ордеров нет
      
      exmo.api_query('user_info',{}, result => {

        let res = JSON.parse(result);
        
        let balance = res.balances[currency1];
        let balance2 = res.balances[currency2];
        //есть ли в наличии currency1 которую можно продать?
        if(balance >= currency1MinQuantity){
          /*
             Высчитываем курс для продажи.
             Нужно продать всю валюту, которую купили, на сумму которую купили + навар и минус комиссия биржи
             Важный момент! Валюты у нас меньше, чем купили - биржа взяла коммисию
          */
          let wannaGet = canSpend + canSpend * (stockFee+profit); //сколько хотим получить
          console.log('sell', balance, wannaGet, (wannaGet/balance));

          let options = {
            "pair": currentPair,
            "quantity": balance,
            "price": wannaGet / balance,
            "type": 'sell'
          };
          exmo.api_query("order_create", options, res => {
          	let result = JSON.parse(res);
            if(result.error) console.log(result.error);
          
            console.log("Создан ордер на продажу", currency1, result.order_id);
            
          });

        }else{
          //currency1 нет, нужно купить

          //Проверяем достаточно ли денег на балансе в валюте currency2
          //console.log(balance2, parseIntcanSpend);
          if(parseInt(balance2) >= parseInt(canSpend)){

            //Узнаем цену за avgPricePeriod, по которой продают currency1
            /*
              У Exmo есть метод ticker с статистикой и объемами торгов по валютным парам, там есть средняя цена
              но она за последние 24 часа и разница с той по которой сейчас идут торги может очень отличатся.
              Из-за этого мы можем долго ждать когда исполниться уже ордер на продажу.
              Мы сделам свой велосипед.
              У Exmo есть метод trades, он возвращает список сделок по валютной паре.
              Мы возьмем совершенные сделки за интересующий нас avgPricePeriod и из них посчитаем средную цену
              Это не идиальный вариант, но покажет реальные цены по которым продают и покупают.
              -----
              Например сейчас когда я пишу это средняя цена BTC_USD 8314 а на бирже покупка идет по цене 7970.
              Если мы выставим ордер по средней цене, он исполнится сразу же по самой минимальной цене которая есть в ордерах на продажу
              Но добавив свой профит + коммисию биржи мы скорей всего будем долго ждать
            */
             exmo.api_query("trades",{"pair":currentPair}, result => {
             	
              let res = JSON.parse(result);
              let prices = [];
				let summ2 = 0;
              for(deal in res[currentPair]){
                let timePassed = 0;
                
                timePassed = (new Date().getTime() / 1000) + stockTimeOffset * 60 * 60 - (res[currentPair][deal].date);
                //console.log(new Date().getTime() / 1000, stockTimeOffset * 60 * 60, res[currentPair][deal].date);
                
                if(timePassed < avgPricePeriod * 60){
                	summ2 += parseInt(res[currentPair][deal].price);
                  prices.push(parseInt(res[currentPair][deal].price));
                }

              }
              //prices = [];
              //let summ = prices.reduce((a,b) => a + b, 0);
              //let summ = summ2 / parseInt(prices.length);

              let avgPrice = summ2 / prices.length;

              /*
              Посчитать, сколько валюты currency1 можно купить.
              На сумму canSpend за минусом stockFee, и с учетом profit
              ( = ниже средней цены рынка, с учетом комиссии и желаемого профита)
              купить больше, потому что биржа потом заберет кусок
              */
              let needPrice = avgPrice - avgPrice * (stockFee + profit);
              let ammount = canSpend / needPrice;

              console.log('Buy', ammount, needPrice);

              //проверям можно ли купить такое кол-во валюты (не нарушается минимальная сумма покупки)
              if(ammount > currency1MinQuantity){
                let options = {
                  "pair": currentPair,
                  "quantity": ammount,
                  "price": needPrice,
                  "type": 'buy'
                };

                exmo.api_query('order_create', options, res => {
            		let result = JSON.parse(res);
                  	if(result.error) console.log(result.error);

                  	console.log('Создан ордер на покупку', result.order_id);
                });

              }else{
                console.log('Выход, не хватает денег на создание ордера');
              }

             });

          }else{
            console.log('Выход, не хватает денег');
          }

        }
      });
    }
  });

}

var timerId = setTimeout(function tick() {
  trade();
  timerId = setTimeout(tick, 5000);
}, 5000);
